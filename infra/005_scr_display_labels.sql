-- Currency is descriptive text, not an ISO-code constraint or posting rule.
ALTER TABLE tenants ALTER COLUMN currency_code TYPE text USING btrim(currency_code);
ALTER TABLE tenants ALTER COLUMN currency_code SET DEFAULT 'SCR';
ALTER TABLE suppliers ALTER COLUMN currency TYPE text USING btrim(currency);
ALTER TABLE suppliers ALTER COLUMN currency SET DEFAULT 'SCR';
ALTER TABLE supplier_cost_history ALTER COLUMN currency TYPE text USING btrim(currency);
ALTER TABLE supplier_receipts ALTER COLUMN currency TYPE text USING btrim(currency);

-- Correct the original MUR bootstrap assumption for Island Vending only.
-- This is a label correction, NOT an exchange conversion: no amounts, quantities,
-- references or IDs change. Restore immutable-record protections before commit.
WITH corrected AS (
  UPDATE tenants SET currency_code='SCR'
  WHERE id='11111111-1111-4111-8111-111111111111' AND currency_code='MUR' RETURNING id
)
INSERT INTO audit_events(tenant_id,actor_id,action,entity_id)
SELECT c.id,u.user_id,'DISPLAY_CURRENCY_CORRECTED',c.id FROM corrected c
JOIN tenant_users u ON u.tenant_id=c.id AND u.user_id='22222222-2222-4222-8222-222222222222';

UPDATE suppliers SET currency='SCR'
WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND currency='MUR';
ALTER TABLE supplier_cost_history DISABLE TRIGGER immutable_supplier_costs;
UPDATE supplier_cost_history SET currency='SCR'
WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND currency='MUR';
ALTER TABLE supplier_cost_history ENABLE TRIGGER immutable_supplier_costs;
ALTER TABLE supplier_receipts DISABLE TRIGGER immutable_receipts;
UPDATE supplier_receipts SET currency='SCR'
WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND currency='MUR';
ALTER TABLE supplier_receipts ENABLE TRIGGER immutable_receipts;
