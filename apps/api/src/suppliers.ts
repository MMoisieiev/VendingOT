import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Actor, pool } from './db';
import { parse } from './validation';

export const moneyInput = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,14})(\.\d{1,4})?$/,
    'Enter a non-negative amount with up to four decimal places',
  );
const text = z.string().trim().max(120).default('');
export const supplierInput = z
  .object({
    legalName: z.string().trim().min(1).max(120),
    contactName: text,
    phone: text,
    email: z.union([z.literal(''), z.email().max(254)]).default(''),
    address: z.string().trim().max(1000).default(''),
    currency: z.string().trim().max(24).default('SCR'),
    active: z.boolean().default(true),
  })
  .strict();
export const supplierProductInput = z
  .object({
    supplierId: z.uuid(),
    productId: z.uuid(),
    supplierSku: text,
    orderUnit: z.string().trim().min(1).max(120),
    unitsPerOrder: z.number().int().min(1).max(1000000),
    unitCost: moneyInput.nullable().default(null),
    leadDays: z.number().int().min(0).max(36500).nullable().default(null),
    preferred: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .strict()
  .refine(
    (v) => v.active || !v.preferred,
    'An inactive link cannot be the preferred supplier',
  );

export async function requireMember(client: PoolClient, actor: Actor) {
  if (
    !(
      await client.query(
        'SELECT 1 FROM tenant_users WHERE tenant_id=$1 AND user_id=$2',
        [actor.tenantId, actor.userId],
      )
    ).rowCount
  )
    throw new ForbiddenException('No membership for this business.');
}
export async function saveSupplier(actor: Actor, raw: unknown, id?: string) {
  const input = parse(supplierInput, raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireMember(client, actor);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    if (id) {
      const old = await client.query(
        'SELECT * FROM suppliers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [actor.tenantId, id],
      );
      if (!old.rowCount) throw new NotFoundException('Supplier not found.');
    }
    const params = [
      actor.tenantId,
      input.legalName,
      input.contactName,
      input.phone,
      input.email,
      input.address,
      input.currency,
      input.active,
    ];
    const result = id
      ? await client.query(
          'UPDATE suppliers SET legal_name=$2,contact_name=$3,phone=$4,email=$5,address=$6,currency=$7,active=$8,updated_at=now() WHERE tenant_id=$1 AND id=$9 RETURNING *',
          [...params, id],
        )
      : await client.query(
          'INSERT INTO suppliers(tenant_id,legal_name,contact_name,phone,email,address,currency,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          params,
        );
    const row = result.rows[0];
    if (id)
      await client.query(
        'UPDATE inventory_locations SET name=$3 WHERE tenant_id=$1 AND supplier_id=$2',
        [actor.tenantId, id, input.legalName],
      );
    else
      await client.query(
        "INSERT INTO inventory_locations(tenant_id,code,name,type,supplier_id) VALUES($1,$2,$3,'EXTERNAL',$4)",
        [actor.tenantId, `SUP-${randomUUID()}`, input.legalName, row.id],
      );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [
        actor.tenantId,
        actor.userId,
        id ? 'SUPPLIER_UPDATED' : 'SUPPLIER_CREATED',
        row.id,
      ],
    );
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveSupplierProduct(actor: Actor, raw: unknown) {
  const input = parse(supplierProductInput, raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireMember(client, actor);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const supplier = await client.query(
      'SELECT * FROM suppliers WHERE tenant_id=$1 AND id=$2',
      [actor.tenantId, input.supplierId],
    );
    if (!supplier.rowCount) throw new NotFoundException('Supplier not found.');
    if (input.active && !supplier.rows[0].active)
      throw new ConflictException(
        'Reactivate this supplier before enabling product links.',
      );
    if (
      !(
        await client.query(
          'SELECT 1 FROM products WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, input.productId],
        )
      ).rowCount
    )
      throw new NotFoundException('Product not found.');
    const old = await client.query(
      'SELECT * FROM supplier_products WHERE tenant_id=$1 AND supplier_id=$2 AND product_id=$3',
      [actor.tenantId, input.supplierId, input.productId],
    );
    if (input.preferred)
      await client.query(
        'UPDATE supplier_products SET preferred=false WHERE tenant_id=$1 AND product_id=$2 AND preferred',
        [actor.tenantId, input.productId],
      );
    const row = (
      await client.query(
        `INSERT INTO supplier_products(tenant_id,supplier_id,product_id,supplier_sku,order_unit,units_per_order,unit_cost,lead_days,preferred,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,supplier_id,product_id) DO UPDATE SET supplier_sku=$4,order_unit=$5,units_per_order=$6,unit_cost=$7,lead_days=$8,preferred=$9,active=$10,updated_at=now() RETURNING *`,
        [
          actor.tenantId,
          input.supplierId,
          input.productId,
          input.supplierSku,
          input.orderUnit,
          input.unitsPerOrder,
          input.unitCost,
          input.leadDays,
          input.preferred,
          input.active,
        ],
      )
    ).rows[0];
    const oldCost = old.rows[0]?.unit_cost as string | null | undefined;
    const sameCost =
      old.rowCount &&
      ((oldCost == null && input.unitCost == null) ||
        (oldCost != null &&
          input.unitCost != null &&
          new Decimal(oldCost).eq(input.unitCost)));
    if (!sameCost)
      await client.query(
        'INSERT INTO supplier_cost_history(tenant_id,supplier_product_id,unit_cost,currency,changed_by) VALUES($1,$2,$3,$4,$5)',
        [
          actor.tenantId,
          row.id,
          input.unitCost,
          supplier.rows[0].currency,
          actor.userId,
        ],
      );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [actor.tenantId, actor.userId, 'SUPPLIER_PRODUCT_SAVED', row.id],
    );
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function supplierCostHistory(actor: Actor, id: string) {
  if (
    !(
      await pool.query(
        'SELECT 1 FROM supplier_products WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, id],
      )
    ).rowCount
  )
    throw new NotFoundException('Supplier product not found.');
  return (
    await pool.query(
      'SELECT unit_cost::text,currency,changed_at FROM supplier_cost_history WHERE tenant_id=$1 AND supplier_product_id=$2 ORDER BY changed_at DESC,id DESC LIMIT 100',
      [actor.tenantId, id],
    )
  ).rows;
}
