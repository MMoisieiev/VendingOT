CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  supplier_number integer NOT NULL, legal_name text NOT NULL,
  contact_name text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '', currency char(3) NOT NULL, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,supplier_number)
);
CREATE UNIQUE INDEX supplier_name_unique ON suppliers(tenant_id,lower(btrim(legal_name)));
CREATE FUNCTION assign_supplier_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO entity_numbers(tenant_id,entity,next_number) VALUES(NEW.tenant_id,'suppliers',2)
  ON CONFLICT(tenant_id,entity) DO UPDATE SET next_number=entity_numbers.next_number+1
  RETURNING next_number-1 INTO NEW.supplier_number;
  RETURN NEW;
END; $$;
CREATE TRIGGER supplier_number BEFORE INSERT ON suppliers FOR EACH ROW EXECUTE FUNCTION assign_supplier_number();
CREATE FUNCTION protect_supplier_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deactivate suppliers instead of deleting their identities'; END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.supplier_number<>OLD.supplier_number
  THEN RAISE EXCEPTION 'Supplier identity cannot change'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER stable_supplier_identity BEFORE UPDATE OR DELETE ON suppliers FOR EACH ROW EXECUTE FUNCTION protect_supplier_identity();
ALTER TABLE inventory_locations ADD COLUMN supplier_id uuid;
ALTER TABLE inventory_locations ADD FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id);
ALTER TABLE inventory_locations ADD UNIQUE(tenant_id,supplier_id);
ALTER TABLE inventory_locations ADD CHECK(supplier_id IS NULL OR type='EXTERNAL');

CREATE TABLE supplier_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL, product_id uuid NOT NULL, supplier_sku text NOT NULL DEFAULT '',
  order_unit text NOT NULL, units_per_order integer NOT NULL CHECK(units_per_order BETWEEN 1 AND 1000000),
  unit_cost numeric(19,4) CHECK(unit_cost>=0), lead_days integer CHECK(lead_days>=0),
  preferred boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,supplier_id,product_id),
  FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
  CHECK(NOT preferred OR active)
);
CREATE UNIQUE INDEX preferred_product_supplier ON supplier_products(tenant_id,product_id) WHERE preferred;
CREATE TABLE supplier_cost_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL, supplier_product_id uuid NOT NULL,
  unit_cost numeric(19,4), currency char(3) NOT NULL, changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,supplier_product_id) REFERENCES supplier_products(tenant_id,id),
  FOREIGN KEY(tenant_id,changed_by) REFERENCES tenant_users(tenant_id,user_id)
);
CREATE TRIGGER immutable_supplier_costs BEFORE UPDATE OR DELETE ON supplier_cost_history FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();

-- Convert legacy supplier names into master records without changing a product,
-- number, cost, ledger entry or existing stock document.
INSERT INTO suppliers(tenant_id,legal_name,currency)
SELECT DISTINCT ON(p.tenant_id,lower(btrim(p.supplier_name))) p.tenant_id,btrim(p.supplier_name),t.currency_code
FROM products p JOIN tenants t ON t.id=p.tenant_id WHERE btrim(p.supplier_name)<>''
ORDER BY p.tenant_id,lower(btrim(p.supplier_name)),p.created_at,p.id;
INSERT INTO inventory_locations(tenant_id,code,name,type,supplier_id)
SELECT tenant_id,'SUP-'||id::text,legal_name,'EXTERNAL',id FROM suppliers;
INSERT INTO supplier_products(tenant_id,supplier_id,product_id,order_unit,units_per_order,unit_cost,preferred)
SELECT p.tenant_id,s.id,p.id,p.pack_label,p.units_per_pack,p.purchase_cost,true
FROM products p JOIN suppliers s ON s.tenant_id=p.tenant_id AND lower(btrim(s.legal_name))=lower(btrim(p.supplier_name));

CREATE TABLE supplier_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  supplier_id uuid NOT NULL, warehouse_id uuid NOT NULL, reference text NOT NULL, received_on date NOT NULL,
  supplier_name_snapshot text NOT NULL, warehouse_name_snapshot text NOT NULL, currency char(3) NOT NULL,
  total_cost numeric(36,4) NOT NULL DEFAULT 0 CHECK(total_cost>=0), note text NOT NULL DEFAULT '',
  posted_by uuid NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL, request_hash text NOT NULL,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  FOREIGN KEY(tenant_id,warehouse_id) REFERENCES inventory_locations(tenant_id,id),
  FOREIGN KEY(tenant_id,posted_by) REFERENCES tenant_users(tenant_id,user_id)
);
CREATE UNIQUE INDEX supplier_delivery_reference ON supplier_receipts(tenant_id,supplier_id,lower(btrim(reference)));
CREATE TABLE supplier_receipt_lines (
  tenant_id uuid NOT NULL, receipt_id uuid NOT NULL, line_number integer NOT NULL,
  supplier_product_id uuid NOT NULL, document_id uuid NOT NULL,
  product_name_snapshot text NOT NULL, supplier_sku_snapshot text NOT NULL,
  entered_quantity numeric(18,3) NOT NULL CHECK(entered_quantity>0), entry_unit text NOT NULL CHECK(entry_unit IN ('ORDER','EA')),
  order_unit_snapshot text NOT NULL, units_per_order_snapshot integer NOT NULL CHECK(units_per_order_snapshot>0),
  base_quantity numeric(18,3) NOT NULL CHECK(base_quantity>0), unit_cost numeric(19,4) NOT NULL CHECK(unit_cost>=0),
  line_total numeric(34,4) NOT NULL CHECK(line_total=base_quantity*unit_cost),
  PRIMARY KEY(tenant_id,receipt_id,line_number), UNIQUE(tenant_id,document_id),
  FOREIGN KEY(tenant_id,receipt_id) REFERENCES supplier_receipts(tenant_id,id),
  FOREIGN KEY(tenant_id,supplier_product_id) REFERENCES supplier_products(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES stock_documents(tenant_id,id)
);
CREATE INDEX receipt_history ON supplier_receipts(tenant_id,posted_at DESC,id);
CREATE TRIGGER immutable_receipts BEFORE UPDATE OR DELETE ON supplier_receipts FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE TRIGGER immutable_receipt_lines BEFORE UPDATE OR DELETE ON supplier_receipt_lines FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();

CREATE FUNCTION check_supplier_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt supplier_receipts; lines integer; cost numeric;
BEGIN
  IF TG_TABLE_NAME='supplier_receipts' THEN SELECT * INTO receipt FROM supplier_receipts WHERE id=NEW.id;
  ELSE SELECT * INTO receipt FROM supplier_receipts WHERE id=NEW.receipt_id; END IF;
  SELECT count(*),sum(line_total) INTO lines,cost FROM supplier_receipt_lines WHERE tenant_id=receipt.tenant_id AND receipt_id=receipt.id;
  IF lines<1 OR lines>100 OR cost<>receipt.total_cost OR EXISTS(
    SELECT 1 FROM supplier_receipt_lines rl
    JOIN supplier_products sp ON sp.id=rl.supplier_product_id AND sp.tenant_id=rl.tenant_id
    JOIN stock_documents d ON d.id=rl.document_id AND d.tenant_id=rl.tenant_id
    JOIN inventory_locations source ON source.id=d.from_location_id AND source.tenant_id=d.tenant_id
    WHERE rl.tenant_id=receipt.tenant_id AND rl.receipt_id=receipt.id AND
      (sp.supplier_id<>receipt.supplier_id OR d.product_id<>sp.product_id OR d.kind<>'RECEIPT'
       OR d.to_location_id<>receipt.warehouse_id OR source.supplier_id IS DISTINCT FROM receipt.supplier_id
       OR d.quantity<>rl.base_quantity OR rl.base_quantity<>rl.entered_quantity*CASE WHEN rl.entry_unit='ORDER' THEN rl.units_per_order_snapshot ELSE 1 END)
  ) THEN RAISE EXCEPTION 'Supplier delivery must match its stock postings and total'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER consistent_receipt AFTER INSERT ON supplier_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplier_receipt();
CREATE CONSTRAINT TRIGGER consistent_receipt_lines AFTER INSERT ON supplier_receipt_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_supplier_receipt();
