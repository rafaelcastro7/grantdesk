/**
 * An amount in the currency the funder published it in. A bare "$" on a
 * Mexican or Brazilian call states the wrong currency, and a missing currency
 * is shown as such rather than assumed to be CAD.
 */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  const code = currency?.trim().toUpperCase();
  if (!code) return `${amount.toLocaleString("en-CA")} (currency not published)`;
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: code,
      currencyDisplay: "code",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString("en-CA")}`;
  }
}
