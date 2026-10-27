-- Keep exact entered pack prices; unit prices are a rounded (8 dp) derivative.
ALTER TABLE products ALTER COLUMN purchase_cost TYPE numeric(23,8);
ALTER TABLE products ADD COLUMN last_purchase_receipt_id uuid;
ALTER TABLE products ADD COLUMN last_purchase_at timestamptz;
ALTER TABLE products ADD COLUMN last_purchase_pack_cost numeric(29,8);
ALTER TABLE products ADD COLUMN last_purchase_pack_size integer;
ALTER TABLE products ADD FOREIGN KEY(tenant_id,last_purchase_receipt_id) REFERENCES supplier_receipts(tenant_id,id);
ALTER TABLE supplier_products ALTER COLUMN unit_cost TYPE numeric(23,8);
ALTER TABLE supplier_products ADD COLUMN pack_cost numeric(29,8);
UPDATE supplier_products SET pack_cost=unit_cost*units_per_order WHERE unit_cost IS NOT NULL;
ALTER TABLE supplier_cost_history ALTER COLUMN unit_cost TYPE numeric(23,8);
ALTER TABLE supplier_cost_history ADD COLUMN pack_cost numeric(29,8);
ALTER TABLE supplier_cost_history ADD COLUMN units_per_order integer;
ALTER TABLE supplier_receipt_lines ALTER COLUMN unit_cost TYPE numeric(23,8);
ALTER TABLE supplier_receipt_lines ADD COLUMN entered_cost numeric(23,8) CHECK(entered_cost>=0);
ALTER TABLE supplier_receipt_lines ADD COLUMN cost_basis text CHECK(cost_basis IN ('ORDER','EA'));
ALTER TABLE supplier_receipt_lines ADD CHECK((cost_basis IS NULL)=(entered_cost IS NULL));
-- The old equality rounded repeating per-unit costs before calculating totals.
ALTER TABLE supplier_receipt_lines DROP CONSTRAINT supplier_receipt_lines_check;
ALTER TABLE supplier_receipt_lines ADD CHECK(
  CASE WHEN cost_basis IS NULL THEN line_total=base_quantity*unit_cost
       WHEN cost_basis='ORDER' THEN line_total=round(base_quantity*entered_cost/units_per_order_snapshot,4)
       ELSE line_total=round(base_quantity*entered_cost,4) END
);

CREATE TABLE supplier_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL, receipt_id uuid NOT NULL, invoice_total numeric(36,2) NOT NULL CHECK(invoice_total>=0),
  adjustment numeric(36,2) NOT NULL DEFAULT 0, adjustment_note text NOT NULL DEFAULT '',
  confirmed boolean NOT NULL DEFAULT true, confirmed_by uuid, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,receipt_id),
  FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES supplier_receipts(tenant_id,id),
  FOREIGN KEY(tenant_id,confirmed_by) REFERENCES tenant_users(tenant_id,user_id)
);
-- Previous deliveries have no recorded payment status or checked invoice total.
-- Do not invent debt: an operator must confirm these legacy invoices first.
INSERT INTO supplier_invoices(tenant_id,supplier_id,receipt_id,invoice_total,confirmed)
SELECT tenant_id,supplier_id,id,round(total_cost,2),false FROM supplier_receipts;
CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, supplier_id uuid NOT NULL,
  amount numeric(38,2) NOT NULL CHECK(amount>=0), paid_on date NOT NULL, reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '', posted_by uuid NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL, request_hash text NOT NULL, UNIQUE(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  FOREIGN KEY(tenant_id,posted_by) REFERENCES tenant_users(tenant_id,user_id)
);
CREATE TABLE supplier_payment_allocations (
  tenant_id uuid NOT NULL, payment_id uuid NOT NULL, invoice_id uuid NOT NULL,
  amount numeric(36,2) NOT NULL CHECK(amount>=0), PRIMARY KEY(tenant_id,payment_id,invoice_id),
  UNIQUE(tenant_id,invoice_id),
  FOREIGN KEY(tenant_id,payment_id) REFERENCES supplier_payments(tenant_id,id),
  FOREIGN KEY(tenant_id,invoice_id) REFERENCES supplier_invoices(tenant_id,id)
);
CREATE TRIGGER immutable_supplier_payments BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE TRIGGER immutable_supplier_allocations BEFORE UPDATE OR DELETE ON supplier_payment_allocations FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE FUNCTION protect_supplier_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.confirmed THEN RAISE EXCEPTION 'Confirmed invoices are immutable'; END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.supplier_id<>OLD.supplier_id OR NEW.receipt_id<>OLD.receipt_id
  THEN RAISE EXCEPTION 'Invoice identity cannot change'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_confirmed_invoice BEFORE UPDATE OR DELETE ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION protect_supplier_invoice();
CREATE FUNCTION check_supplier_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment supplier_payments; n integer; total numeric;
BEGIN
  IF TG_TABLE_NAME='supplier_payments' THEN SELECT * INTO payment FROM supplier_payments WHERE id=NEW.id;
  ELSE SELECT * INTO payment FROM supplier_payments WHERE id=NEW.payment_id; END IF;
  SELECT count(*),sum(amount) INTO n,total FROM supplier_payment_allocations WHERE tenant_id=payment.tenant_id AND payment_id=payment.id;
  IF n<1 OR total<>payment.amount OR EXISTS(
    SELECT 1 FROM supplier_payment_allocations a JOIN supplier_invoices i ON i.tenant_id=a.tenant_id AND i.id=a.invoice_id
    WHERE a.tenant_id=payment.tenant_id AND a.payment_id=payment.id AND
    (i.supplier_id<>payment.supplier_id OR NOT i.confirmed OR a.amount<>i.invoice_total)
  ) THEN RAISE EXCEPTION 'Payment must settle matching confirmed invoices exactly'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER balanced_supplier_payment AFTER INSERT ON supplier_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplier_payment();
CREATE CONSTRAINT TRIGGER balanced_supplier_allocations AFTER INSERT ON supplier_payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplier_payment();
CREATE INDEX supplier_invoice_account ON supplier_invoices(tenant_id,supplier_id,created_at DESC,id);
