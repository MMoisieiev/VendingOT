import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { Actor, pool } from './db';
import { postMovement } from './inventory';
import { parse } from './validation';

export const refillInput = z
  .object({
    sourceLocationId: z.uuid(),
    note: z.string().trim().max(500).default(''),
    lines: z
      .array(
        z
          .object({
            productId: z.uuid(),
            quantity: z.string().regex(/^[1-9]\d{0,14}$/),
            entryUnit: z.enum(['EA', 'PACK']),
            expectedUnitsPerPack: z.number().int().min(1).max(1000000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export async function machineHistory(actor: Actor, machineId: string) {
  const machine = await pool.query(
    'SELECT m.*,l.id AS location_id FROM machines m JOIN inventory_locations l ON l.machine_id=m.id AND l.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.id=$2',
    [actor.tenantId, machineId],
  );
  if (!machine.rowCount) throw new NotFoundException('Machine not found.');
  const history = await pool.query(
    `SELECT d.id,d.kind,d.quantity::text,d.entered_quantity::text,d.entered_unit,d.units_per_pack_snapshot,
    d.posted_at,d.note,d.reversal_of,p.name AS product_name,p.item_number,p.unit_label,p.pack_label,
    f.name AS from_name,t.name AS to_name,u.display_name AS posted_by,
    r.refill_id,r.unit_price_snapshot::text,
    EXISTS(SELECT 1 FROM stock_documents rev WHERE rev.tenant_id=d.tenant_id AND rev.reversal_of=d.id) AS reversed
    FROM stock_documents d JOIN products p ON p.id=d.product_id AND p.tenant_id=d.tenant_id
    JOIN inventory_locations f ON f.id=d.from_location_id AND f.tenant_id=d.tenant_id
    JOIN inventory_locations t ON t.id=d.to_location_id AND t.tenant_id=d.tenant_id
    JOIN users u ON u.id=d.posted_by
    LEFT JOIN machine_refill_lines r ON r.document_id=d.id AND r.tenant_id=d.tenant_id
    WHERE d.tenant_id=$1 AND (d.from_location_id=$2 OR d.to_location_id=$2)
    ORDER BY d.posted_at DESC,d.id DESC LIMIT 200`,
    [actor.tenantId, machine.rows[0].location_id],
  );
  return { machine: machine.rows[0], history: history.rows };
}

export async function postRefill(
  actor: Actor,
  machineId: string,
  key: string,
  raw: unknown,
) {
  const input = parse(refillInput, raw);
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(key))
    throw new BadRequestException('Supply a valid Idempotency-Key.');
  const hash = createHash('sha256')
    .update(JSON.stringify({ machineId, ...input }))
    .digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const prior = await client.query(
      'SELECT id,request_hash FROM machine_refills WHERE tenant_id=$1 AND idempotency_key=$2',
      [actor.tenantId, key],
    );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== hash)
        throw new ConflictException(
          'This key was already used for a different refill.',
        );
      await client.query('COMMIT');
      return { id: prior.rows[0].id, replayed: true };
    }
    const machine = await client.query(
      'SELECT m.*,l.id AS location_id FROM machines m JOIN inventory_locations l ON l.machine_id=m.id AND l.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.id=$2 FOR UPDATE OF m',
      [actor.tenantId, machineId],
    );
    if (!machine.rowCount) throw new NotFoundException('Machine not found.');
    if (machine.rows[0].status !== 'ACTIVE')
      throw new ConflictException('Only active machines can be refilled.');
    const source = await client.query(
      "SELECT 1 FROM inventory_locations WHERE tenant_id=$1 AND id=$2 AND type IN ('WAREHOUSE','VEHICLE')",
      [actor.tenantId, input.sourceLocationId],
    );
    if (!source.rowCount)
      throw new NotFoundException('Source warehouse or van not found.');
    const header = await client.query(
      'INSERT INTO machine_refills(tenant_id,machine_id,source_location_id,posted_by,price_tier_id,note,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [
        actor.tenantId,
        machineId,
        input.sourceLocationId,
        actor.userId,
        machine.rows[0].price_tier_id,
        input.note,
        key,
        hash,
      ],
    );
    const id: string = header.rows[0].id;
    for (const [index, line] of input.lines.entries()) {
      // The parent transaction owns every line, audit and outbox write: all or none.
      const document = await postMovement(
        actor,
        `refill:${id}:${index}`,
        {
          ...line,
          kind: 'TRANSFER',
          fromLocationId: input.sourceLocationId,
          toLocationId: machine.rows[0].location_id,
          note: input.note,
        },
        client,
      );
      const price = await client.query(
        'SELECT amount FROM product_prices WHERE tenant_id=$1 AND product_id=$2 AND price_tier_id=$3',
        [actor.tenantId, line.productId, machine.rows[0].price_tier_id],
      );
      await client.query(
        'INSERT INTO machine_refill_lines(tenant_id,refill_id,line_number,document_id,unit_price_snapshot) VALUES($1,$2,$3,$4,$5)',
        [
          actor.tenantId,
          id,
          index + 1,
          document.id,
          price.rows[0]?.amount ?? null,
        ],
      );
    }
    await client.query('COMMIT');
    return { id, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
