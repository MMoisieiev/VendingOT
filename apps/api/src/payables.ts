import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Actor, pool } from './db';
import { requireMember } from './suppliers';
import { parse } from './validation';
const Exact = Decimal.clone({ precision: 60 });
export const invoiceMoney = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,31})(\.\d{1,2})?$/,
    'Enter an amount with at most two decimal places',
  );
export const adjustmentMoney = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,31})(\.\d{1,2})?$/);
export const paymentInput = z
  .object({
    invoiceIds: z.array(z.uuid()).min(1).max(100),
    paidOn: z.iso.date(),
    stage: z.enum(['PAID', 'IN_BANK']).default('PAID'),
    reference: z.string().trim().max(120).default(''),
    note: z.string().trim().max(500).default(''),
  })
  .strict()
  .refine(
    (v) => new Set(v.invoiceIds).size === v.invoiceIds.length,
    'Select each invoice only once',
  );
export const invoiceConfirmation = z
  .object({ invoiceTotal: invoiceMoney })
  .strict();

export async function recordPayment(
  actor: Actor,
  supplierId: string,
  key: string,
  raw: unknown,
  transaction?: PoolClient,
) {
  const input = parse(paymentInput, raw);
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(key))
    throw new BadRequestException('Supply a valid Idempotency-Key.');
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        supplierId,
        ...input,
        invoiceIds: [...input.invoiceIds].sort(),
      }),
    )
    .digest('hex');
  const client = transaction ?? (await pool.connect());
  try {
    if (!transaction) await client.query('BEGIN');
    await requireMember(client, actor);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const prior = await client.query(
      'SELECT id,request_hash FROM supplier_payments WHERE tenant_id=$1 AND idempotency_key=$2',
      [actor.tenantId, key],
    );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== hash)
        throw new ConflictException(
          'This key was already used for a different payment.',
        );
      if (!transaction) await client.query('COMMIT');
      return { id: prior.rows[0].id, replayed: true };
    }
    const invoices = await client.query(
      `SELECT i.*,EXISTS(SELECT 1 FROM supplier_payment_allocations a WHERE a.tenant_id=i.tenant_id AND a.invoice_id=i.id) AS paid FROM supplier_invoices i WHERE i.tenant_id=$1 AND i.supplier_id=$2 AND i.id=ANY($3::uuid[]) FOR UPDATE`,
      [actor.tenantId, supplierId, input.invoiceIds],
    );
    if (invoices.rowCount !== input.invoiceIds.length)
      throw new NotFoundException(
        'One or more invoices were not found for this supplier.',
      );
    if (invoices.rows.some((i) => !i.confirmed))
      throw new ConflictException(
        'Confirm legacy invoice totals and status before paying them.',
      );
    if (invoices.rows.some((i) => i.paid))
      throw new ConflictException(
        'One or more selected invoices have already been paid. Refresh the account.',
      );
    const total = invoices.rows
      .reduce((sum, row) => sum.add(row.invoice_total), new Exact(0))
      .toFixed(2);
    const id: string = (
      await client.query(
        'INSERT INTO supplier_payments(tenant_id,supplier_id,amount,paid_on,reference,note,posted_by,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [
          actor.tenantId,
          supplierId,
          total,
          input.paidOn,
          input.reference,
          input.note,
          actor.userId,
          key,
          hash,
        ],
      )
    ).rows[0].id;
    for (const invoice of invoices.rows)
      await client.query(
        'INSERT INTO supplier_payment_allocations(tenant_id,payment_id,invoice_id,amount) VALUES($1,$2,$3,$4)',
        [actor.tenantId, id, invoice.id, invoice.invoice_total],
      );
    await client.query(
      'INSERT INTO supplier_payment_events(tenant_id,payment_id,event_type,event_on,reference,note,request_hash,posted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        actor.tenantId,
        id,
        input.stage === 'PAID' ? 'CLEARED' : 'SENT',
        input.paidOn,
        input.reference,
        input.note,
        hash,
        actor.userId,
      ],
    );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [
        actor.tenantId,
        actor.userId,
        input.stage === 'PAID'
          ? 'SUPPLIER_INVOICES_PAID'
          : 'SUPPLIER_PAYMENT_SENT',
        id,
      ],
    );
    await client.query(
      'INSERT INTO domain_outbox(tenant_id,event_type,payload) VALUES($1,$2,$3)',
      [
        actor.tenantId,
        'supplier.payment_recorded',
        JSON.stringify({
          paymentId: id,
          invoiceIds: input.invoiceIds,
          amount: total,
        }),
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

export async function confirmInvoice(
  actor: Actor,
  supplierId: string,
  invoiceId: string,
  raw: unknown,
) {
  const input = parse(invoiceConfirmation, raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireMember(client, actor);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const row = (
      await client.query(
        'SELECT i.*,r.total_cost AS goods_total FROM supplier_invoices i JOIN supplier_receipts r ON r.id=i.receipt_id AND r.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND i.supplier_id=$2 AND i.id=$3 FOR UPDATE OF i',
        [actor.tenantId, supplierId, invoiceId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Invoice not found.');
    if (row.confirmed)
      throw new ConflictException('This invoice is already confirmed.');
    await client.query(
      'UPDATE supplier_invoices SET invoice_total=$4,confirmed=true,confirmed_by=$5,confirmed_at=now(),adjustment=$6,adjustment_note=$7 WHERE tenant_id=$1 AND supplier_id=$2 AND id=$3',
      [
        actor.tenantId,
        supplierId,
        invoiceId,
        input.invoiceTotal,
        actor.userId,
        new Exact(input.invoiceTotal)
          .sub(new Exact(row.goods_total).toDecimalPlaces(2))
          .toFixed(2),
        'Legacy invoice total confirmed from records',
      ],
    );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [actor.tenantId, actor.userId, 'LEGACY_INVOICE_CONFIRMED', invoiceId],
    );
    await client.query('COMMIT');
    return { id: invoiceId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const stateSql = `CASE WHEN NOT i.confirmed THEN 'UNCONFIRMED' WHEN i.invoice_total=0 OR EXISTS(SELECT 1 FROM supplier_payment_allocations a JOIN supplier_payment_events e ON e.tenant_id=a.tenant_id AND e.payment_id=a.payment_id AND e.event_type='CLEARED' WHERE a.tenant_id=i.tenant_id AND a.invoice_id=i.id) THEN 'PAID' WHEN EXISTS(SELECT 1 FROM supplier_payment_allocations a WHERE a.tenant_id=i.tenant_id AND a.invoice_id=i.id) THEN 'IN_BANK' ELSE 'UNPAID' END`;
export async function supplierAccount(
  actor: Actor,
  supplierId: string,
  raw: unknown = {},
) {
  const query = parse(
    z
      .object({
        status: z
          .enum(['ALL', 'UNPAID', 'IN_BANK', 'PAID', 'UNCONFIRMED'])
          .default('ALL'),
        cursor: z.uuid().optional(),
      })
      .strict(),
    raw,
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (
      !(
        await client.query(
          'SELECT 1 FROM suppliers WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, supplierId],
        )
      ).rowCount
    )
      throw new NotFoundException('Supplier not found.');
    const today = (
      await client.query(
        'SELECT (now() AT TIME ZONE timezone)::date::text AS today FROM tenants WHERE id=$1',
        [actor.tenantId],
      )
    ).rows[0].today;
    const summary = (
      await client.query(
        `SELECT COALESCE(sum(invoice_total) FILTER(WHERE status IN ('UNPAID','IN_BANK')),0)::text AS outstanding,COALESCE(sum(invoice_total) FILTER(WHERE status='IN_BANK'),0)::text AS in_bank_amount,COALESCE(sum(invoice_total) FILTER(WHERE status='UNPAID' AND days_left<=2),0)::text AS pay_now_amount,COALESCE(sum(invoice_total) FILTER(WHERE status='UNPAID' AND days_left>2),0)::text AS hold_amount,COALESCE(sum(invoice_total) FILTER(WHERE status='UNPAID' AND days_left<0),0)::text AS overdue_amount,count(*) FILTER(WHERE status='UNPAID')::int AS unpaid_count,count(*) FILTER(WHERE status='IN_BANK')::int AS in_bank_count,count(*) FILTER(WHERE status='PAID')::int AS paid_count,count(*) FILTER(WHERE status='UNCONFIRMED')::int AS unconfirmed_count FROM(SELECT invoice_total,${stateSql} AS status,due_on-$3::date AS days_left FROM supplier_invoices i WHERE tenant_id=$1 AND supplier_id=$2) invoices`,
        [actor.tenantId, supplierId, today],
      )
    ).rows[0];
    const rows = await client.query(
      `SELECT i.*,i.invoice_date::text AS invoice_date,i.due_on::text AS due_on,i.due_on-$5::date AS days_left,${stateSql} AS status,r.reference,r.received_on::text AS received_on,r.total_cost::text AS goods_total,r.currency,pa.payment_id,(SELECT event_on::text FROM supplier_payment_events e WHERE e.tenant_id=p.tenant_id AND e.payment_id=p.id AND e.event_type='CLEARED') AS paid_on,p.paid_on::text AS bank_init_date FROM supplier_invoices i JOIN supplier_receipts r ON r.id=i.receipt_id AND r.tenant_id=i.tenant_id LEFT JOIN supplier_payment_allocations pa ON pa.invoice_id=i.id AND pa.tenant_id=i.tenant_id LEFT JOIN supplier_payments p ON p.id=pa.payment_id AND p.tenant_id=pa.tenant_id WHERE i.tenant_id=$1 AND i.supplier_id=$2 AND ($3='ALL' OR ${stateSql}=$3) AND ($4::uuid IS NULL OR (i.created_at,i.id)<(SELECT created_at,id FROM supplier_invoices WHERE tenant_id=$1 AND supplier_id=$2 AND id=$4)) ORDER BY i.created_at DESC,i.id DESC LIMIT 101`,
      [actor.tenantId, supplierId, query.status, query.cursor ?? null, today],
    );
    const payments = (
      await client.query(
        `SELECT p.*,p.paid_on::text AS paid_on,CASE WHEN EXISTS(SELECT 1 FROM supplier_payment_events e WHERE e.tenant_id=p.tenant_id AND e.payment_id=p.id AND e.event_type='CLEARED') THEN 'PAID' ELSE 'IN_BANK' END AS stage,(SELECT event_on::text FROM supplier_payment_events e WHERE e.tenant_id=p.tenant_id AND e.payment_id=p.id AND e.event_type='CLEARED') AS cleared_on,(SELECT json_agg(r.reference ORDER BY r.reference) FROM supplier_payment_allocations a JOIN supplier_invoices i ON i.id=a.invoice_id AND i.tenant_id=a.tenant_id JOIN supplier_receipts r ON r.id=i.receipt_id AND r.tenant_id=i.tenant_id WHERE a.payment_id=p.id AND a.tenant_id=p.tenant_id) AS invoices FROM supplier_payments p WHERE p.tenant_id=$1 AND p.supplier_id=$2 ORDER BY p.posted_at DESC,p.id DESC LIMIT 50`,
        [actor.tenantId, supplierId],
      )
    ).rows;
    await client.query('COMMIT');
    return {
      summary,
      invoices: rows.rows.slice(0, 100),
      nextCursor: rows.rows.length > 100 ? rows.rows[99].id : null,
      payments,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function clearPayment(
  actor: Actor,
  supplierId: string,
  paymentId: string,
  raw: unknown,
) {
  const input = parse(
    z
      .object({
        clearedOn: z.iso.date(),
        reference: z.string().trim().max(120).default(''),
        note: z.string().trim().max(500).default(''),
      })
      .strict(),
    raw,
  );
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireMember(client, actor);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const payment = (
      await client.query(
        'SELECT *,paid_on::text AS bank_date FROM supplier_payments WHERE tenant_id=$1 AND supplier_id=$2 AND id=$3',
        [actor.tenantId, supplierId, paymentId],
      )
    ).rows[0];
    if (!payment) throw new NotFoundException('Payment not found.');
    const prior = (
      await client.query(
        "SELECT * FROM supplier_payment_events WHERE tenant_id=$1 AND payment_id=$2 AND event_type='CLEARED'",
        [actor.tenantId, paymentId],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new ConflictException('This payment has already cleared.');
      await client.query('COMMIT');
      return { id: paymentId, replayed: true };
    }
    if (input.clearedOn < payment.bank_date)
      throw new BadRequestException(
        'Cleared date cannot precede the bank initiation date.',
      );
    await client.query(
      "INSERT INTO supplier_payment_events(tenant_id,payment_id,event_type,event_on,reference,note,request_hash,posted_by) VALUES($1,$2,'CLEARED',$3,$4,$5,$6,$7)",
      [
        actor.tenantId,
        paymentId,
        input.clearedOn,
        input.reference,
        input.note,
        hash,
        actor.userId,
      ],
    );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [actor.tenantId, actor.userId, 'SUPPLIER_PAYMENT_CLEARED', paymentId],
    );
    await client.query('COMMIT');
    return { id: paymentId, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
