ALTER TABLE suppliers ADD COLUMN credit_days integer NOT NULL DEFAULT 21 CHECK(credit_days BETWEEN 0 AND 36500);
ALTER TABLE supplier_invoices ADD COLUMN invoice_date date;
ALTER TABLE supplier_invoices ADD COLUMN credit_days_snapshot integer;
ALTER TABLE supplier_invoices ADD COLUMN due_on date;
ALTER TABLE supplier_invoices DISABLE TRIGGER immutable_confirmed_invoice;
UPDATE supplier_invoices i SET invoice_date=r.received_on,credit_days_snapshot=s.credit_days,due_on=r.received_on+s.credit_days
FROM supplier_receipts r,suppliers s WHERE r.tenant_id=i.tenant_id AND r.id=i.receipt_id AND s.tenant_id=i.tenant_id AND s.id=i.supplier_id;
ALTER TABLE supplier_invoices ENABLE TRIGGER immutable_confirmed_invoice;
ALTER TABLE supplier_invoices ALTER COLUMN invoice_date SET NOT NULL;
ALTER TABLE supplier_invoices ALTER COLUMN credit_days_snapshot SET NOT NULL;
ALTER TABLE supplier_invoices ALTER COLUMN due_on SET NOT NULL;
ALTER TABLE supplier_invoices ADD CHECK(credit_days_snapshot BETWEEN 0 AND 36500);
CREATE TABLE supplier_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,payment_id uuid NOT NULL,
  event_type text NOT NULL CHECK(event_type IN ('SENT','CLEARED')),event_on date NOT NULL,
  reference text NOT NULL DEFAULT '',note text NOT NULL DEFAULT '',request_hash text NOT NULL,
  posted_by uuid NOT NULL,posted_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,payment_id,event_type),
  FOREIGN KEY(tenant_id,payment_id) REFERENCES supplier_payments(tenant_id,id),
  FOREIGN KEY(tenant_id,posted_by) REFERENCES tenant_users(tenant_id,user_id)
);
-- Payments recorded by the previous version were explicitly marked paid.
INSERT INTO supplier_payment_events(tenant_id,payment_id,event_type,event_on,reference,note,request_hash,posted_by)
SELECT tenant_id,id,'CLEARED',paid_on,reference,'Existing recorded payment','legacy-paid',posted_by FROM supplier_payments;
CREATE TRIGGER immutable_supplier_payment_events BEFORE UPDATE OR DELETE ON supplier_payment_events FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
