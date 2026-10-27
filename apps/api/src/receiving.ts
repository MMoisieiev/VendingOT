import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { Actor, pool } from './db';
import { postMovement } from './inventory';
import {
  moneyInput,
  unitCostInput,
  requireMember,
  saveSupplierProduct,
} from './suppliers';
import { invoiceMoney, adjustmentMoney, recordPayment } from './payables';
import { parse } from './validation';
const ExactDecimal = Decimal.clone({ precision: 50 });

export const receiptInput = z
  .object({
    supplierId: z.uuid(),
    warehouseId: z.uuid(),
    reference: z.string().trim().min(1).max(120),
    receivedOn: z.iso.date(),
    invoiceDate: z.iso.date().optional(),
    dueDate: z.iso.date().optional(),
    note: z.string().trim().max(500).default(''),
    invoiceTotal: invoiceMoney.optional(),
    invoiceAdjustment: adjustmentMoney.default('0'),
    adjustmentNote: z.string().trim().max(500).default(''),
    paid: z.boolean().default(false),
    paymentDate: z.iso.date().optional(),
    paymentReference: z.string().trim().max(120).default(''),
    lines: z
      .array(
        z
          .object({
            supplierProductId: z.uuid().optional(),
            productId: z.uuid().optional(),
            quantity: z.string().regex(/^[1-9]\d{0,14}$/),
            entryUnit: z.enum(['ORDER', 'EA']),
            expectedUnitsPerOrder: z.number().int().min(1).max(1000000),
            arrivalPackSize: z.number().int().min(1).max(1000000).optional(),
            unitCost: unitCostInput.optional(),
            packCost: moneyInput.optional(),
          })
          .strict()
          .refine(
            (l) => Boolean(l.productId) !== Boolean(l.supplierProductId),
            'Select a product',
          )
          .refine(
            (l) => (l.packCost !== undefined) !== (l.unitCost !== undefined),
            'Enter a pack cost or unit cost',
          ),
      )
      .min(1)
      .max(100),
  })
  .strict();

export async function postReceipt(actor: Actor, key: string, raw: unknown) {
  const input = parse(receiptInput, raw);
  if (input.paid && input.invoiceTotal === undefined)
    throw new BadRequestException(
      'Enter the checked invoice total before recording payment.',
    );
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(key))
    throw new BadRequestException('Supply a valid Idempotency-Key.');
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireMember(client, actor);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      actor.tenantId,
    ]);
    const prior = await client.query(
      'SELECT id,request_hash FROM supplier_receipts WHERE tenant_id=$1 AND idempotency_key=$2',
      [actor.tenantId, key],
    );
    if (prior.rowCount) {
      if (prior.rows[0].request_hash !== hash)
        throw new ConflictException(
          'This key was already used for a different delivery.',
        );
      await client.query('COMMIT');
      return { id: prior.rows[0].id, replayed: true };
    }
    const supplier = (
      await client.query(
        'SELECT s.*,l.id AS source_id FROM suppliers s JOIN inventory_locations l ON l.supplier_id=s.id AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.id=$2 FOR SHARE OF s',
        [actor.tenantId, input.supplierId],
      )
    ).rows[0];
    if (!supplier) throw new NotFoundException('Supplier not found.');
    if (!supplier.active)
      throw new ConflictException('This supplier is inactive.');
    const warehouse = (
      await client.query(
        "SELECT * FROM inventory_locations WHERE tenant_id=$1 AND id=$2 AND type='WAREHOUSE'",
        [actor.tenantId, input.warehouseId],
      )
    ).rows[0];
    if (!warehouse) throw new NotFoundException('Warehouse not found.');
    const existing = await client.query(
      'SELECT 1 FROM supplier_receipts WHERE tenant_id=$1 AND supplier_id=$2 AND lower(btrim(reference))=lower($3)',
      [actor.tenantId, input.supplierId, input.reference],
    );
    if (existing.rowCount)
      throw new ConflictException(
        'This invoice or delivery reference has already been received for this supplier.',
      );
    const prepared = [];
    let total = new ExactDecimal(0);
    for (const line of input.lines) {
      let link;
      if (line.supplierProductId)
        link = (
          await client.query(
            `SELECT sp.*,p.name,p.archived FROM supplier_products sp JOIN products p ON p.id=sp.product_id AND p.tenant_id=sp.tenant_id WHERE sp.tenant_id=$1 AND sp.id=$2 AND sp.supplier_id=$3 FOR SHARE OF sp,p`,
            [actor.tenantId, line.supplierProductId, input.supplierId],
          )
        ).rows[0];
      else {
        const product = (
          await client.query(
            'SELECT * FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [actor.tenantId, line.productId],
          )
        ).rows[0];
        if (!product) throw new NotFoundException('Product not found.');
        link = (
          await client.query(
            'SELECT * FROM supplier_products WHERE tenant_id=$1 AND supplier_id=$2 AND product_id=$3 FOR UPDATE',
            [actor.tenantId, input.supplierId, line.productId],
          )
        ).rows[0];
        if (!link) {
          if (product.units_per_pack !== line.expectedUnitsPerOrder)
            throw new ConflictException(
              'Product pack size changed. Refresh and review the delivery.',
            );
          link = await saveSupplierProduct(
            actor,
            {
              supplierId: input.supplierId,
              productId: product.id,
              orderUnit: product.pack_label,
              unitsPerOrder: product.units_per_pack,
              unitCost: null,
            },
            client,
          );
        }
        link = { ...link, name: product.name, archived: product.archived };
      }
      if (!link)
        throw new NotFoundException(
          'A selected product is not linked to this supplier.',
        );
      if (!link.active || link.archived)
        throw new ConflictException('A selected supplier product is inactive.');
      if (link.units_per_order !== line.expectedUnitsPerOrder)
        throw new ConflictException(
          'Supplier pack size changed. Refresh and review the delivery before posting.',
        );
      if (line.arrivalPackSize !== undefined)
        link = { ...link, units_per_order: line.arrivalPackSize };
      const quantity = new ExactDecimal(line.quantity).mul(
        line.entryUnit === 'ORDER' ? link.units_per_order : 1,
      );
      if (quantity.gt('999999999999999'))
        throw new BadRequestException(
          'Converted delivery quantity is too large.',
        );
      const enteredCost = line.packCost ?? line.unitCost!;
      const costBasis = line.packCost !== undefined ? 'ORDER' : 'EA';
      const unitCost =
        costBasis === 'ORDER'
          ? new ExactDecimal(enteredCost).div(link.units_per_order).toFixed(8)
          : new ExactDecimal(enteredCost).toFixed(8);
      const lineTotal = (
        costBasis === 'ORDER'
          ? quantity.mul(enteredCost).div(link.units_per_order)
          : quantity.mul(enteredCost)
      ).toDecimalPlaces(4);
      total = total.add(lineTotal);
      prepared.push({
        line,
        link,
        quantity: quantity.toFixed(0),
        lineTotal: lineTotal.toFixed(4),
        unitCost,
        enteredCost,
        costBasis,
      });
    }
    const adjustment = new ExactDecimal(input.invoiceAdjustment);
    if (!adjustment.isZero() && input.adjustmentNote.length < 3)
      throw new BadRequestException('Explain the invoice charges or discount.');
    const checkedTotal = total.toDecimalPlaces(2).add(adjustment);
    if (checkedTotal.isNegative())
      throw new BadRequestException('Invoice total cannot be negative.');
    if (
      input.invoiceTotal !== undefined &&
      !checkedTotal.eq(input.invoiceTotal)
    )
      throw new ConflictException(
        `Invoice does not match: calculated ${checkedTotal.toFixed(2)}, entered ${input.invoiceTotal}. Check pack costs or explain charges/discount.`,
      );
    const id: string = (
      await client.query(
        `INSERT INTO supplier_receipts(tenant_id,supplier_id,warehouse_id,reference,received_on,supplier_name_snapshot,warehouse_name_snapshot,currency,total_cost,note,posted_by,idempotency_key,request_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          actor.tenantId,
          input.supplierId,
          input.warehouseId,
          input.reference,
          input.receivedOn,
          supplier.legal_name,
          warehouse.name,
          supplier.currency,
          total.toFixed(4),
          input.note,
          actor.userId,
          key,
          hash,
        ],
      )
    ).rows[0].id;
    for (const [index, item] of prepared.entries()) {
      const document = await postMovement(
        actor,
        `receipt:${id}:${index}`,
        {
          kind: 'RECEIPT',
          productId: item.link.product_id,
          fromLocationId: supplier.source_id,
          toLocationId: input.warehouseId,
          quantity: item.quantity,
          entryUnit: 'EA',
          note: `Delivery ${input.reference}${input.note ? `: ${input.note}` : ''}`.slice(
            0,
            500,
          ),
        },
        client,
      );
      await client.query(
        `INSERT INTO supplier_receipt_lines(tenant_id,receipt_id,line_number,supplier_product_id,document_id,product_name_snapshot,supplier_sku_snapshot,entered_quantity,entry_unit,order_unit_snapshot,units_per_order_snapshot,base_quantity,unit_cost,line_total,entered_cost,cost_basis)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          actor.tenantId,
          id,
          index + 1,
          item.link.id,
          document.id,
          item.link.name,
          item.link.supplier_sku,
          item.line.quantity,
          item.line.entryUnit,
          item.link.order_unit,
          item.link.units_per_order,
          item.quantity,
          item.unitCost,
          item.lineTotal,
          item.enteredCost,
          item.costBasis,
        ],
      );
    }
    for (const item of prepared) {
      const packCost =
        item.costBasis === 'ORDER'
          ? new ExactDecimal(item.enteredCost)
          : new ExactDecimal(item.enteredCost).mul(item.link.units_per_order);
      await saveSupplierProduct(
        actor,
        {
          supplierId: input.supplierId,
          productId: item.link.product_id,
          supplierSku: item.link.supplier_sku,
          orderUnit: item.link.order_unit,
          unitsPerOrder: item.link.units_per_order,
          unitCost: item.unitCost,
          leadDays: item.link.lead_days,
          preferred: item.link.preferred,
          active: true,
        },
        client,
        packCost.toFixed(8),
      );
      await client.query(
        'UPDATE products SET purchase_cost=$3,supplier_name=$4,last_purchase_receipt_id=$5,last_purchase_at=now(),last_purchase_pack_cost=$6,last_purchase_pack_size=$7 WHERE tenant_id=$1 AND id=$2',
        [
          actor.tenantId,
          item.link.product_id,
          item.unitCost,
          supplier.legal_name,
          id,
          packCost.toFixed(8),
          item.link.units_per_order,
        ],
      );
    }
    const invoiceId: string = (
      await client.query(
        'INSERT INTO supplier_invoices(tenant_id,supplier_id,receipt_id,invoice_total,adjustment,adjustment_note,confirmed_by,confirmed_at,confirmed,invoice_date,credit_days_snapshot,due_on) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now() ELSE NULL END,$8,$9,$10,COALESCE($11::date,$9::date+$10::integer)) RETURNING id',
        [
          actor.tenantId,
          input.supplierId,
          id,
          checkedTotal.toFixed(2),
          adjustment.toFixed(2),
          input.adjustmentNote,
          input.invoiceTotal === undefined ? null : actor.userId,
          input.invoiceTotal !== undefined,
          input.invoiceDate ?? input.receivedOn,
          supplier.credit_days,
          input.dueDate ?? null,
        ],
      )
    ).rows[0].id;
    if (input.paid)
      await recordPayment(
        actor,
        input.supplierId,
        `receipt-paid:${id}`,
        {
          invoiceIds: [invoiceId],
          paidOn: input.paymentDate ?? input.receivedOn,
          reference: input.paymentReference,
          note: 'Recorded as paid on receipt',
        },
        client,
      );
    await client.query(
      'INSERT INTO audit_events(tenant_id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)',
      [actor.tenantId, actor.userId, 'SUPPLIER_DELIVERY_RECEIVED', id],
    );
    await client.query('COMMIT');
    return { id, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function receiptHistory(actor: Actor) {
  return (
    await pool.query(
      `SELECT r.*,r.received_on::text AS received_on,i.id AS invoice_id,i.invoice_total::text,CASE WHEN NOT i.confirmed THEN 'UNCONFIRMED' WHEN i.invoice_total=0 OR EXISTS(SELECT 1 FROM supplier_payment_allocations pa JOIN supplier_payment_events e ON e.tenant_id=pa.tenant_id AND e.payment_id=pa.payment_id AND e.event_type='CLEARED' WHERE pa.tenant_id=i.tenant_id AND pa.invoice_id=i.id) THEN 'PAID' WHEN EXISTS(SELECT 1 FROM supplier_payment_allocations pa WHERE pa.tenant_id=i.tenant_id AND pa.invoice_id=i.id) THEN 'IN_BANK' ELSE 'UNPAID' END AS payment_status,
    (SELECT json_agg(json_build_object('line_number',rl.line_number,'product_name',rl.product_name_snapshot,'supplier_sku',rl.supplier_sku_snapshot,'entered_quantity',rl.entered_quantity::text,'entry_unit',rl.entry_unit,'order_unit',rl.order_unit_snapshot,'units_per_order',rl.units_per_order_snapshot,'base_quantity',rl.base_quantity::text,'unit_cost',rl.unit_cost::text,'line_total',rl.line_total::text,'entered_cost',rl.entered_cost::text,'cost_basis',rl.cost_basis,'reversed',EXISTS(SELECT 1 FROM stock_documents d WHERE d.tenant_id=rl.tenant_id AND d.reversal_of=rl.document_id)) ORDER BY rl.line_number)
    FROM supplier_receipt_lines rl WHERE rl.tenant_id=r.tenant_id AND rl.receipt_id=r.id) AS lines
    FROM supplier_receipts r JOIN supplier_invoices i ON i.receipt_id=r.id AND i.tenant_id=r.tenant_id WHERE r.tenant_id=$1 ORDER BY r.posted_at DESC,r.id DESC LIMIT 50`,
      [actor.tenantId],
    )
  ).rows;
}
