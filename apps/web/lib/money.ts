export function scaled(value: string, places: number): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m || (m[3]?.length ?? 0) > places) return null;
  return (
    (BigInt(m[2]) * 10n ** BigInt(places) +
      BigInt((m[3] ?? '').padEnd(places, '0'))) *
    (m[1] ? -1n : 1n)
  );
}
export function decimal(value: bigint, places: number) {
  const sign = value < 0 ? '-' : '';
  const n = value < 0 ? -value : value;
  const factor = 10n ** BigInt(places);
  return `${sign}${n / factor}.${(n % factor).toString().padStart(places, '0')}`;
}
export function roundedDivide(n: bigint, d: bigint) {
  return n < 0 ? -((-n + d / 2n) / d) : (n + d / 2n) / d;
}
export function receiptLine(
  quantity: string,
  size: number,
  entry: 'ORDER' | 'EA',
  cost: string,
) {
  if (!Number.isInteger(size) || size < 1 || size > 1000000) return null;
  if (!/^[1-9]\d{0,14}$/.test(quantity)) return null;
  const price = scaled(cost, 8);
  if (price === null || price < 0) return null;
  const entered = BigInt(quantity);
  const units = entered * BigInt(entry === 'ORDER' ? size : 1);
  return {
    units,
    total: roundedDivide(entered * price, 10000n),
    unitCost: entry === 'ORDER' ? roundedDivide(price, BigInt(size)) : price,
  };
}
