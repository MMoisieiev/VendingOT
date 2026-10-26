import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { Actor, pool } from './db';
import { parse } from './validation';

const label = z.string().trim().min(1).max(120);
const optionalLabel = z.string().trim().max(120).default('');
const money = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,14})(\.\d{1,4})?$/,
    'Enter a non-negative amount with up to four decimal places',
  );
export const tierInput = z.object({ name: label }).strict();
export const productInput = z
  .object({
    sku: label,
    name: label,
    unitLabel: label.default('Unit'),
    packLabel: label.default('Pack'),
    unitsPerPack: z.coerce.number().int().min(1).max(1000000).default(1),
    defaultEntryUnit: z.enum(['EA', 'PACK']).default('EA'),
    barcode: optionalLabel,
    packBarcode: optionalLabel,
    supplierName: optionalLabel,
    purchaseCost: money.nullable().default(null),
    prices: z
      .array(z.object({ tierId: z.uuid(), amount: money }).strict())
      .max(50)
      .default([]),
  })
  .strict()
  .refine(
    (p) => new Set(p.prices.map((v) => v.tierId)).size === p.prices.length,
    'A price tier can only be listed once',
  );
export const machineInput = z
  .object({
    name: label,
    code: optionalLabel,
    siteName: optionalLabel,
    serialNumber: optionalLabel,
    manufacturer: optionalLabel,
    model: optionalLabel,
    status: z.enum(['ACTIVE', 'INACTIVE', 'MAINTENANCE']).default('ACTIVE'),
    priceTierId: z.uuid(),
  })
  .strict();

export async function createTier(actor: Actor, raw: unknown) {
  const data = parse(tierInput, raw);
  return (
    await pool.query(
      'INSERT INTO price_tiers(tenant_id,name) VALUES($1,$2) RETURNING *',
      [actor.tenantId, data.name],
    )
  ).rows[0];
}

export async function saveProduct(actor: Actor, raw: unknown, id?: string) {
  const data = parse(productInput, raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (data.prices.length) {
      const tiers = await client.query(
        'SELECT id FROM price_tiers WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
        [actor.tenantId, data.prices.map((p) => p.tierId)],
      );
      if (tiers.rowCount !== data.prices.length)
        throw new NotFoundException('Price tier not found in this business.');
    }
    const params = [
      actor.tenantId,
      data.sku,
      data.name,
      data.unitLabel,
      data.packLabel,
      data.unitsPerPack,
      data.defaultEntryUnit,
      data.barcode,
      data.packBarcode,
      data.supplierName,
      data.purchaseCost,
    ];
    const result = id
      ? await client.query(
          `UPDATE products SET sku=$2,name=$3,unit_label=$4,pack_label=$5,units_per_pack=$6,default_entry_unit=$7,barcode=$8,pack_barcode=$9,supplier_name=$10,purchase_cost=$11 WHERE tenant_id=$1 AND id=$12 RETURNING *`,
          [...params, id],
        )
      : await client.query(
          `INSERT INTO products(tenant_id,sku,name,unit_label,pack_label,units_per_pack,default_entry_unit,barcode,pack_barcode,supplier_name,purchase_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          params,
        );
    if (!result.rowCount) throw new NotFoundException('Product not found.');
    const product = result.rows[0];
    await client.query(
      'DELETE FROM product_prices WHERE tenant_id=$1 AND product_id=$2',
      [actor.tenantId, product.id],
    );
    for (const price of data.prices)
      await client.query(
        'INSERT INTO product_prices(tenant_id,product_id,price_tier_id,amount) VALUES($1,$2,$3,$4)',
        [actor.tenantId, product.id, price.tierId, price.amount],
      );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [
        actor.tenantId,
        actor.userId,
        id ? 'PRODUCT_UPDATED' : 'PRODUCT_CREATED',
        product.id,
      ],
    );
    await client.query('COMMIT');
    return product;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export const createProduct = (actor: Actor, raw: unknown) =>
  saveProduct(actor, raw);

export async function saveMachine(actor: Actor, raw: unknown, id?: string) {
  const data = parse(machineInput, raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (
      !(
        await client.query(
          'SELECT 1 FROM price_tiers WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, data.priceTierId],
        )
      ).rowCount
    )
      throw new NotFoundException('Price tier not found in this business.');
    // A UUID-based legacy code is internal bookkeeping when no optional asset code is provided.
    const existing = id
      ? await client.query(
          'SELECT code FROM machines WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, id],
        )
      : null;
    const params = [
      actor.tenantId,
      data.name,
      data.code || existing?.rows[0]?.code || `ASSET-${randomUUID()}`,
      data.siteName,
      data.serialNumber,
      data.manufacturer,
      data.model,
      data.status,
      data.priceTierId,
    ];
    const result = id
      ? await client.query(
          'UPDATE machines SET name=$2,code=$3,site_name=$4,serial_number=$5,manufacturer=$6,model=$7,status=$8,price_tier_id=$9 WHERE tenant_id=$1 AND id=$10 RETURNING *',
          [...params, id],
        )
      : await client.query(
          'INSERT INTO machines(tenant_id,name,code,site_name,serial_number,manufacturer,model,status,price_tier_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          params,
        );
    if (!result.rowCount) throw new NotFoundException('Machine not found.');
    const machine = result.rows[0];
    if (id)
      await client.query(
        'UPDATE inventory_locations SET name=$3,code=$4 WHERE tenant_id=$1 AND machine_id=$2',
        [actor.tenantId, id, machine.name, machine.code],
      );
    else
      await client.query(
        "INSERT INTO inventory_locations(tenant_id,name,code,type,machine_id) VALUES($1,$2,$3,'MACHINE',$4)",
        [actor.tenantId, machine.name, machine.code, machine.id],
      );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [
        actor.tenantId,
        actor.userId,
        id ? 'MACHINE_UPDATED' : 'MACHINE_CREATED',
        machine.id,
      ],
    );
    await client.query('COMMIT');
    return machine;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
