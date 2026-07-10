export function formatCurrency(value: number | undefined | null): string {
  if (value === undefined || value === null) return "$0";
  const absValue = Math.abs(value);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(absValue);
  
  return value < 0 ? `-${formatted}` : formatted;
}

export function formatCount(value: number | undefined | null): string {
  if (value === undefined || value === null) return "0";
  return new Intl.NumberFormat("en-US").format(value);
}
