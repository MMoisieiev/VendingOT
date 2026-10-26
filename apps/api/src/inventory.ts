import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { Actor, pool } from './db';
import type { PoolClient } from 'pg';
import { parse } from './validation';
export { parse } from './validation';
export { createProduct, productInput } from './catalog';

const label = z.string().trim().min(1).max(120);
export const locationInput = z
  .object({
    code: label,
    name: label,
    type: z.enum(['WAREHOUSE', 'VEHICLE', 'MACHINE']),
  })
  .strict();
export const movementInput = z
  .object({
    kind: z.enum(['RECEIPT', 'TRANSFER']),
    productId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    entryUnit: z.enum(['EA', 'PACK']).optional(),
    expectedUnitsPerPack: z.number().int().min(1).max(1000000).optional(),
    quantity: z
      .string()
      .regex(
        /^[1-9]\d{0,14}$/,
        'Enter a positive whole number, up to 15 digits',
      ),
    note: z.string().trim().max(500).default(''),
  })
  .strict();
export type Movement = z.infer<typeof movementInput>;
export const reversalInput = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

function conflict(code: string, message: string): never {
  throw new ConflictException({ code, message });
}

export async function overview(actor: Actor) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tenant = await client.query(
      'SELECT id,name,currency_code,timezone FROM tenants WHERE id=$1',
      [actor.tenantId],
    );
    const products = await client.query(
      'SELECT * FROM products WHERE tenant_id=$1 ORDER BY item_number',
      [actor.tenantId],
    );
    const locations = await client.query(
      'SELECT id,code,name,type,machine_id FROM inventory_locations WHERE tenant_id=$1 ORDER BY type,code',
      [actor.tenantId],
    );
    const balances = await client.query(
      `SELECT e.location_id,e.product_id,sum(e.quantity_delta)::text AS quantity
      FROM inventory_ledger_entries e JOIN inventory_locations l ON l.id=e.location_id AND l.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND l.type IN ('WAREHOUSE','VEHICLE') GROUP BY e.location_id,e.product_id ORDER BY e.location_id,e.product_id`,
      [actor.tenantId],
    );
    const movements = await client.query(
      `SELECT d.id,d.kind,d.quantity::text,d.entered_quantity::text,d.entered_unit,d.units_per_pack_snapshot,d.note,d.posted_at,d.reversal_of, d.from_location_id,d.to_location_id,
      p.name AS product_name,f.name AS from_name,t.name AS to_name,u.display_name AS posted_by,
      EXISTS(SELECT 1 FROM stock_documents r WHERE r.tenant_id=d.tenant_id AND r.reversal_of=d.id) AS reversed
      FROM stock_documents d JOIN products p ON p.id=d.product_id AND p.tenant_id=d.tenant_id
      JOIN inventory_locations f ON f.id=d.from_location_id AND f.tenant_id=d.tenant_id
      JOIN inventory_locations t ON t.id=d.to_location_id AND t.tenant_id=d.tenant_id
      JOIN users u ON u.id=d.posted_by WHERE d.tenant_id=$1 ORDER BY d.posted_at DESC,d.id DESC LIMIT 50`,
      [actor.tenantId],
    );
    const machines = await client.query(
      'SELECT m.*,l.id AS location_id,t.name AS tier_name FROM machines m JOIN inventory_locations l ON l.machine_id=m.id AND l.tenant_id=m.tenant_id JOIN price_tiers t ON t.id=m.price_tier_id AND t.tenant_id=m.tenant_id WHERE m.tenant_id=$1 ORDER BY m.machine_number',
      [actor.tenantId],
    );
    const tiers = await client.query(
      'SELECT * FROM price_tiers WHERE tenant_id=$1 ORDER BY is_default DESC,name',
      [actor.tenantId],
    );
    const prices = await client.query(
      'SELECT product_id,price_tier_id,amount::text FROM product_prices WHERE tenant_id=$1',
      [actor.tenantId],
    );
    await client.query('COMMIT');
    return {
      machines: machines.rows,
      tiers: tiers.rows,
      prices: prices.rows,
      tenant: tenant.rows[0],
      products: products.rows,
      locations: locations.rows,
      balances: balances.rows,
      movements: movements.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createLocation(
  actor: Actor,
  data: z.infer<typeof locationInput>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let machineId: string | null = null;
    if (data.type === 'MACHINE') {
      machineId = (
        await client.query(
          'INSERT INTO machines(tenant_id,code,name) VALUES ($1,$2,$3) RETURNING id',
          [actor.tenantId, data.code, data.name],
        )
      ).rows[0].id;
    }
    const result = await client.query(
      'INSERT INTO inventory_locations(tenant_id,code,name,type,machine_id) VALUES ($1,$2,$3,$4,$5) RETURNING id,code,name,type',
      [actor.tenantId, data.code, data.name, data.type, machineId],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Serialize posting per tenant for this pilot. It keeps balance checks and retry handling atomic.
// Replace with ordered per-balance locks if measured throughput requires finer locking.
export async function postMovement(
  actor: Actor,
  key: string,
  input: Movement | { reversalOf: string; reason: string },
  transaction?: PoolClient,
) {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(key))
    throw new BadRequestException({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message:
        'Supply an Idempotency-Key of 8–128 letters, digits, colons, underscores or hyphens.',
    });
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const client = transaction ?? (await pool.connect());
  try {
    if (!transaction) await client.query('BEGIN');
    const membership = await client.query(
      'SELECT role FROM tenant_users WHERE tenant_id=$1 AND user_id=$2',
      [actor.tenantId, actor.userId],
    );
    if (!membership.rowCount)
      throw new ForbiddenException('No membership for this business.');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const prior = await client.query(
      'SELECT request_hash,document_id FROM idempotency_records WHERE tenant_id=$1 AND key=$2',
      [actor.tenantId, key],
    );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== hash)
        conflict(
          'IDEMPOTENCY_CONFLICT',
          'This key was already used for a different movement.',
        );
      if (!transaction) await client.query('COMMIT');
      return { id: prior.rows[0].document_id as string, replayed: true };
    }
    let data: Movement;
    let reversalOf: string | null = null;
    if ('reversalOf' in input) {
      if (membership.rows[0].role !== 'OWNER')
        throw new ForbiddenException('An owner must reverse posted stock.');
      const original = await client.query(
        'SELECT * FROM stock_documents WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, input.reversalOf],
      );
      if (!original.rowCount)
        throw new NotFoundException('Movement not found.');
      const row = original.rows[0];
      if (row.kind === 'REVERSAL')
        conflict(
          'INVALID_REVERSAL',
          'Create a new movement instead of reversing a reversal.',
        );
      const reversed = await client.query(
        'SELECT 1 FROM stock_documents WHERE tenant_id=$1 AND reversal_of=$2',
        [actor.tenantId, row.id],
      );
      if (reversed.rowCount)
        conflict('ALREADY_REVERSED', 'This movement already has a reversal.');
      reversalOf = row.id;
      data = {
        kind: 'TRANSFER',
        productId: row.product_id,
        fromLocationId: row.to_location_id,
        toLocationId: row.from_location_id,
        quantity: row.quantity,
        note: input.reason,
      };
    } else data = input;
    if (data.fromLocationId === data.toLocationId)
      throw new BadRequestException('Source and destination must differ.');
    const locations = await client.query(
      'SELECT id,type FROM inventory_locations WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
      [actor.tenantId, [data.fromLocationId, data.toLocationId]],
    );
    const source = locations.rows.find((row) => row.id === data.fromLocationId);
    const target = locations.rows.find((row) => row.id === data.toLocationId);
    const product = await client.query(
      'SELECT units_per_pack FROM products WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [actor.tenantId, data.productId],
    );
    if (!source || !target || !product.rowCount)
      throw new NotFoundException(
        'Product or location not found in this business.',
      );
    const enteredQuantity = data.quantity;
    const entryUnit = data.entryUnit ?? 'EA';
    const packSize = product.rows[0].units_per_pack;
    if (
      data.expectedUnitsPerPack !== undefined &&
      data.expectedUnitsPerPack !== packSize
    )
      conflict(
        'PACK_SIZE_CHANGED',
        'The product pack size changed. Refresh and review the quantities before posting.',
      );
    if (entryUnit === 'PACK')
      data = {
        ...data,
        quantity: new Decimal(data.quantity).mul(packSize).toFixed(0),
      };
    if (new Decimal(data.quantity).gt('999999999999999'))
      throw new BadRequestException('Converted quantity is too large.');
    if (
      !reversalOf &&
      ((data.kind === 'RECEIPT' &&
        (source.type !== 'EXTERNAL' || target.type !== 'WAREHOUSE')) ||
        (data.kind === 'TRANSFER' &&
          (source.type === 'EXTERNAL' || target.type === 'EXTERNAL')))
    ) {
      throw new BadRequestException(
        'Receipts move external stock into a warehouse. Transfers move between internal locations.',
      );
    }
    if (source.type !== 'EXTERNAL') {
      const balance = await client.query(
        'SELECT COALESCE(sum(quantity_delta),0)::text AS quantity FROM inventory_ledger_entries WHERE tenant_id=$1 AND location_id=$2 AND product_id=$3',
        [actor.tenantId, data.fromLocationId, data.productId],
      );
      if (new Decimal(balance.rows[0].quantity).lt(data.quantity))
        conflict(
          'INV_INSUFFICIENT_STOCK',
          'The source does not have enough stock.',
        );
    }
    const document = await client.query(
      `INSERT INTO stock_documents(tenant_id,kind,from_location_id,to_location_id,product_id,quantity,note,reversal_of,posted_by,entered_quantity,entered_unit,units_per_pack_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        actor.tenantId,
        reversalOf ? 'REVERSAL' : data.kind,
        data.fromLocationId,
        data.toLocationId,
        data.productId,
        data.quantity,
        data.note,
        reversalOf,
        actor.userId,
        enteredQuantity,
        entryUnit,
        packSize,
      ],
    );
    const id: string = document.rows[0].id;
    await client.query(
      `INSERT INTO inventory_ledger_entries(tenant_id,document_id,location_id,product_id,quantity_delta)
      VALUES ($1,$2,$3,$5,-$6::numeric),($1,$2,$4,$5,$6::numeric)`,
      [
        actor.tenantId,
        id,
        data.fromLocationId,
        data.toLocationId,
        data.productId,
        data.quantity,
      ],
    );
    await client.query(
      'INSERT INTO idempotency_records(tenant_id,key,request_hash,document_id) VALUES ($1,$2,$3,$4)',
      [actor.tenantId, key, hash, id],
    );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES ($1,$2,$3,$4)',
      [
        actor.tenantId,
        actor.userId,
        reversalOf ? 'STOCK_REVERSED' : 'STOCK_POSTED',
        id,
      ],
    );
    await client.query(
      'INSERT INTO domain_outbox(tenant_id,event_type,payload) VALUES ($1,$2,$3)',
      [
        actor.tenantId,
        'inventory.posted',
        JSON.stringify({ documentId: id, reversalOf }),
      ],
    );
    if (!transaction) await client.query('COMMIT');
    return { id, replayed: false };
  } catch (error) {
    if (!transaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!transaction) client.release();
  }
}
