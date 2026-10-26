-- Preserve UUID links and all existing postings. New human-facing numbers are
-- assigned once, independently for products and machines within each business.
CREATE TABLE entity_numbers (
  tenant_id uuid NOT NULL REFERENCES tenants, entity text NOT NULL,
  next_number integer NOT NULL CHECK(next_number > 0), PRIMARY KEY(tenant_id,entity)
);
ALTER TABLE products ADD COLUMN item_number integer;
ALTER TABLE machines ADD COLUMN machine_number integer;
WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY tenant_id ORDER BY created_at,id) AS n FROM products)
UPDATE products p SET item_number=n.n FROM numbered n WHERE p.id=n.id;
WITH numbered AS (SELECT id,row_number() OVER (PARTITION BY tenant_id ORDER BY created_at,id) AS n FROM machines)
UPDATE machines m SET machine_number=n.n FROM numbered n WHERE m.id=n.id;
INSERT INTO entity_numbers SELECT tenant_id,'products',max(item_number)+1 FROM products GROUP BY tenant_id;
INSERT INTO entity_numbers SELECT tenant_id,'machines',max(machine_number)+1 FROM machines GROUP BY tenant_id;
ALTER TABLE products ALTER COLUMN item_number SET NOT NULL;
ALTER TABLE machines ALTER COLUMN machine_number SET NOT NULL;
ALTER TABLE products ADD UNIQUE(tenant_id,item_number);
ALTER TABLE machines ADD UNIQUE(tenant_id,machine_number);
CREATE FUNCTION assign_entity_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE number integer;
BEGIN
  INSERT INTO entity_numbers(tenant_id,entity,next_number) VALUES(NEW.tenant_id,TG_TABLE_NAME,2)
  ON CONFLICT(tenant_id,entity) DO UPDATE SET next_number=entity_numbers.next_number+1
  RETURNING next_number-1 INTO number;
  IF TG_TABLE_NAME='products' THEN NEW.item_number=number; ELSE NEW.machine_number=number; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER product_number BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION assign_entity_number();
CREATE TRIGGER machine_number BEFORE INSERT ON machines FOR EACH ROW EXECUTE FUNCTION assign_entity_number();
CREATE FUNCTION protect_entity_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive records instead of deleting permanent identities'; END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR
    (TG_TABLE_NAME='products' AND to_jsonb(NEW)->>'item_number' IS DISTINCT FROM to_jsonb(OLD)->>'item_number') OR
    (TG_TABLE_NAME='machines' AND to_jsonb(NEW)->>'machine_number' IS DISTINCT FROM to_jsonb(OLD)->>'machine_number')
  THEN RAISE EXCEPTION 'Item and machine identities cannot change'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER stable_product_identity BEFORE UPDATE OR DELETE ON products FOR EACH ROW EXECUTE FUNCTION protect_entity_identity();
CREATE TRIGGER stable_machine_identity BEFORE UPDATE OR DELETE ON machines FOR EACH ROW EXECUTE FUNCTION protect_entity_identity();

CREATE TABLE price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants,
  name text NOT NULL, is_default boolean NOT NULL DEFAULT false, UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX unique_tier_name ON price_tiers(tenant_id,lower(name));
CREATE UNIQUE INDEX one_default_tier ON price_tiers(tenant_id) WHERE is_default;
INSERT INTO price_tiers(tenant_id,name,is_default) SELECT id,'Default',true FROM tenants;
CREATE FUNCTION create_default_tier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO price_tiers(tenant_id,name,is_default) VALUES(NEW.id,'Default',true); RETURN NEW; END; $$;
CREATE TRIGGER tenant_default_tier AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION create_default_tier();

ALTER TABLE products
  ADD COLUMN units_per_pack integer NOT NULL DEFAULT 1 CHECK(units_per_pack BETWEEN 1 AND 1000000),
  ADD COLUMN pack_label text NOT NULL DEFAULT 'Pack',
  ADD COLUMN unit_label text NOT NULL DEFAULT 'Unit',
  ADD COLUMN default_entry_unit text NOT NULL DEFAULT 'EA' CHECK(default_entry_unit IN ('EA','PACK')),
  ADD COLUMN barcode text NOT NULL DEFAULT '',
  ADD COLUMN pack_barcode text NOT NULL DEFAULT '',
  ADD COLUMN supplier_name text NOT NULL DEFAULT '',
  ADD COLUMN purchase_cost numeric(19,4) CHECK(purchase_cost>=0),
  ADD COLUMN archived boolean NOT NULL DEFAULT false;
CREATE TABLE product_prices (
  tenant_id uuid NOT NULL, product_id uuid NOT NULL, price_tier_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL CHECK(amount>=0),
  PRIMARY KEY(tenant_id,product_id,price_tier_id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY(tenant_id,price_tier_id) REFERENCES price_tiers(tenant_id,id)
);
ALTER TABLE machines
  ADD COLUMN site_name text NOT NULL DEFAULT '',
  ADD COLUMN serial_number text NOT NULL DEFAULT '',
  ADD COLUMN manufacturer text NOT NULL DEFAULT '',
  ADD COLUMN model text NOT NULL DEFAULT '',
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE','MAINTENANCE')),
  ADD COLUMN price_tier_id uuid,
  ADD FOREIGN KEY(tenant_id,price_tier_id) REFERENCES price_tiers(tenant_id,id);
UPDATE machines m SET price_tier_id=t.id FROM price_tiers t WHERE t.tenant_id=m.tenant_id AND t.is_default;
ALTER TABLE machines ALTER COLUMN price_tier_id SET NOT NULL;
CREATE FUNCTION assign_default_machine_tier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_tier_id IS NULL THEN SELECT id INTO NEW.price_tier_id FROM price_tiers WHERE tenant_id=NEW.tenant_id AND is_default; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER default_machine_tier BEFORE INSERT ON machines FOR EACH ROW EXECUTE FUNCTION assign_default_machine_tier();

ALTER TABLE stock_documents
  ADD COLUMN entered_quantity numeric(18,3),
  ADD COLUMN entered_unit text CHECK(entered_unit IN ('EA','PACK')),
  ADD COLUMN units_per_pack_snapshot integer;

CREATE TABLE machine_refills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  machine_id uuid NOT NULL, source_location_id uuid NOT NULL, posted_by uuid NOT NULL,
  price_tier_id uuid NOT NULL, note text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL, request_hash text NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,machine_id) REFERENCES machines(tenant_id,id),
  FOREIGN KEY(tenant_id,source_location_id) REFERENCES inventory_locations(tenant_id,id),
  FOREIGN KEY(tenant_id,posted_by) REFERENCES tenant_users(tenant_id,user_id),
  FOREIGN KEY(tenant_id,price_tier_id) REFERENCES price_tiers(tenant_id,id)
);
CREATE TABLE machine_refill_lines (
  tenant_id uuid NOT NULL, refill_id uuid NOT NULL, line_number integer NOT NULL,
  document_id uuid NOT NULL, unit_price_snapshot numeric(19,4),
  PRIMARY KEY(tenant_id,refill_id,line_number), UNIQUE(tenant_id,document_id),
  FOREIGN KEY(tenant_id,refill_id) REFERENCES machine_refills(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id) REFERENCES stock_documents(tenant_id,id)
);
CREATE TRIGGER immutable_refills BEFORE UPDATE OR DELETE ON machine_refills FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
CREATE TRIGGER immutable_refill_lines BEFORE UPDATE OR DELETE ON machine_refill_lines FOR EACH ROW EXECUTE FUNCTION reject_posted_mutation();
