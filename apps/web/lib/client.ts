export type Tier = { id: string; name: string; is_default: boolean };
export type Product = {
  id: string;
  item_number: number;
  sku: string;
  name: string;
  unit: string;
  unit_label: string;
  pack_label: string;
  units_per_pack: number;
  default_entry_unit: 'EA' | 'PACK';
  barcode: string;
  pack_barcode: string;
  supplier_name: string;
  purchase_cost: string | null;
};
export type Machine = {
  id: string;
  machine_number: number;
  name: string;
  code: string;
  site_name: string;
  serial_number: string;
  manufacturer: string;
  model: string;
  status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
  price_tier_id: string;
  tier_name: string;
  location_id: string;
};
export type Location = {
  id: string;
  code: string;
  name: string;
  type: 'WAREHOUSE' | 'VEHICLE' | 'MACHINE' | 'EXTERNAL';
  machine_id: string | null;
  supplier_id: string | null;
};
export type Supplier = {
  id: string;
  supplier_number: number;
  legal_name: string;
  contact_name: string;
  phone: string;
  email: string;
  address: string;
  currency: string;
  active: boolean;
};
export type SupplierProduct = {
  id: string;
  supplier_id: string;
  product_id: string;
  supplier_sku: string;
  order_unit: string;
  units_per_order: number;
  unit_cost: string | null;
  lead_days: number | null;
  preferred: boolean;
  active: boolean;
};
export type SupplierReceipt = {
  id: string;
  supplier_id: string;
  reference: string;
  received_on: string;
  supplier_name_snapshot: string;
  warehouse_name_snapshot: string;
  currency: string;
  total_cost: string;
  note: string;
  posted_at: string;
  lines: {
    line_number: number;
    product_name: string;
    supplier_sku: string;
    entered_quantity: string;
    entry_unit: 'ORDER' | 'EA';
    order_unit: string;
    units_per_order: number;
    base_quantity: string;
    unit_cost: string;
    line_total: string;
    reversed: boolean;
  }[];
};
export type Movement = {
  id: string;
  kind: string;
  quantity: string;
  entered_quantity: string | null;
  entered_unit: string | null;
  units_per_pack_snapshot: number | null;
  note: string;
  posted_at: string;
  reversal_of: string | null;
  product_name: string;
  from_name: string;
  to_name: string;
  posted_by: string;
  reversed: boolean;
  from_location_id: string;
  to_location_id: string;
};
export type Overview = {
  tenant: { name: string; timezone: string; currency_code: string };
  products: Product[];
  locations: Location[];
  machines: Machine[];
  tiers: Tier[];
  prices: { product_id: string; price_tier_id: string; amount: string }[];
  suppliers: Supplier[];
  supplierProducts: SupplierProduct[];
  balances: { location_id: string; product_id: string; quantity: string }[];
  movements: Movement[];
};
export type Save = (
  path: string,
  payload: unknown,
  message: string,
  idempotent?: boolean,
) => Promise<boolean>;
export async function api<T>(
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(
    `/api/v1/${path}`,
    body
      ? {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          body: JSON.stringify(body),
        }
      : { cache: 'no-store' },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      Array.isArray(data.message)
        ? data.message.join(', ')
        : (data.message ?? 'The request failed. Please try again.'),
    );
  return data;
}
export const prettyQuantity = (value: string) =>
  new Intl.NumberFormat('en-MU', { maximumFractionDigits: 3 }).format(
    Number(value),
  );
export const amount = (value: string | null | undefined, currency: string) => {
  if (value == null) return 'Not set';
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return `${currency ? currency + ' ' : ''}${value}`;
  const fraction = (match[2] ?? '').replace(/0+$/, '').padEnd(2, '0');
  return `${currency ? currency + ' ' : ''}${BigInt(match[1]).toLocaleString('en-MU')}.${fraction}`;
};
