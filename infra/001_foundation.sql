CREATE TABLE tenants (
  id uuid PRIMARY KEY, name text NOT NULL,
  currency_code char(3) NOT NULL DEFAULT 'MUR', timezone text NOT NULL DEFAULT 'Indian/Mauritius',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (id uuid PRIMARY KEY, display_name text NOT NULL);
CREATE TABLE tenant_users (
  tenant_id uuid NOT NULL REFERENCES tenants, user_id uuid NOT NULL REFERENCES users,
  role text NOT NULL CHECK (role IN ('OWNER','OPERATOR')), PRIMARY KEY (tenant_id,user_id)
);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  sku text NOT NULL, name text NOT NULL, unit text NOT NULL DEFAULT 'EA' CHECK (unit = 'EA'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,sku)
);
CREATE TABLE machines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  code text NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,code)
);
CREATE TABLE inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  code text NOT NULL, name text NOT NULL,
  type text NOT NULL CHECK (type IN ('WAREHOUSE','VEHICLE','MACHINE','EXTERNAL')),
  machine_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,code), UNIQUE (tenant_id,machine_id),
  FOREIGN KEY (tenant_id,machine_id) REFERENCES machines(tenant_id,id),
  CHECK ((type = 'MACHINE') = (machine_id IS NOT NULL))
);
CREATE TABLE stock_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  kind text NOT NULL CHECK (kind IN ('RECEIPT','TRANSFER','REVERSAL')),
  from_location_id uuid NOT NULL, to_location_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0 AND quantity = trunc(quantity)),
  note text NOT NULL DEFAULT '', reversal_of uuid, posted_by uuid NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,reversal_of),
  FOREIGN KEY (tenant_id,from_location_id) REFERENCES inventory_locations(tenant_id,id),
  FOREIGN KEY (tenant_id,to_location_id) REFERENCES inventory_locations(tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY (tenant_id,posted_by) REFERENCES tenant_users(tenant_id,user_id),
  FOREIGN KEY (tenant_id,reversal_of) REFERENCES stock_documents(tenant_id,id),
  CHECK (from_location_id <> to_location_id),
  CHECK ((kind = 'REVERSAL') = (reversal_of IS NOT NULL))
);
CREATE TABLE inventory_ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL, document_id uuid NOT NULL, location_id uuid NOT NULL, product_id uuid NOT NULL,
  quantity_delta numeric(18,3) NOT NULL CHECK (quantity_delta <> 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,document_id) REFERENCES stock_documents(tenant_id,id),
  FOREIGN KEY (tenant_id,location_id) REFERENCES inventory_locations(tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
  UNIQUE (document_id,location_id)
);
CREATE INDEX ledger_balance_idx ON inventory_ledger_entries(tenant_id,location_id,product_id);
CREATE INDEX documents_history_idx ON stock_documents(tenant_id,posted_at DESC,id);
CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES tenants, key text NOT NULL, request_hash text NOT NULL,
  document_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,key),
  FOREIGN KEY (tenant_id,document_id) REFERENCES stock_documents(tenant_id,id)
);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL,
  actor_id uuid NOT NULL, action text NOT NULL, entity_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES tenant_users(tenant_id,user_id)
);
CREATE TABLE domain_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE FUNCTION reject_posted_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Posted records are immutable; create a reversal'; END;
$$;
CREATE TRIGGER immutable_documents BEFORE UPDATE OR DELETE ON stock_documents FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON inventory_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE FUNCTION check_stock_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d stock_documents; n integer; total numeric;
BEGIN
  IF TG_TABLE_NAME = 'stock_documents' THEN
    SELECT * INTO d FROM stock_documents WHERE id = NEW.id;
  ELSE
    SELECT * INTO d FROM stock_documents WHERE id = NEW.document_id;
  END IF;
  SELECT count(*), COALESCE(sum(quantity_delta),0) INTO n,total FROM inventory_ledger_entries WHERE document_id = d.id;
  IF n <> 2 OR total <> 0 OR NOT EXISTS (
    SELECT 1 FROM inventory_ledger_entries WHERE document_id=d.id AND location_id=d.from_location_id AND product_id=d.product_id AND quantity_delta=-d.quantity
  ) OR NOT EXISTS (
    SELECT 1 FROM inventory_ledger_entries WHERE document_id=d.id AND location_id=d.to_location_id AND product_id=d.product_id AND quantity_delta=d.quantity
  ) THEN RAISE EXCEPTION 'Stock posting must have exactly two matching balanced entries'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_document AFTER INSERT ON stock_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_posting();
CREATE CONSTRAINT TRIGGER balanced_entries AFTER INSERT ON inventory_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_stock_posting();
