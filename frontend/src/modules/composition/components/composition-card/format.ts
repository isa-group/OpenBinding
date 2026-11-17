/** A cost as the card prints it: the number, grouped, and the unit the evaluation gave. */
export function formatCost(value: number, unit?: string | null): string {
  const number = value.toLocaleString('en', { maximumFractionDigits: 2 });
  return unit ? `${number} ${unit}` : number;
}
