// The gateway's amounts are fixed six-place decimal strings ("549.000000"). They are written here by working on the text:
// money to two places (the margin table's rounding), any other value without its trailing zeros, digits grouped by
// thousands. Nothing is read as a number and nothing is computed (plan §2.4, F6 "no fourth semantics").

import { isNegative, twoPlaces } from '../margin-table/money';

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** "1234567" → "1,234,567". */
function grouped(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The normaliser reads a number of 100,000,000 or more as Unlimited (its sentinel, F3 O10); a value of nine integer
 * digits or more is said so.
 */
export function isSentinel(value: string): boolean {
  const match = DECIMAL.exec(value);
  return Boolean(match && !match[1] && match[2].replace(/^0+/, '').length >= 9);
}

/** "150000.000000" → "150,000"; "0.999500" → "0.9995"; "100000000.000000" → "Unlimited"; other text as it is. */
export function decimalText(value: string): string {
  const match = DECIMAL.exec(value);
  if (!match) return value;
  if (isSentinel(value)) return 'Unlimited';
  const [, sign, whole, fraction = ''] = match;
  const kept = fraction.replace(/0+$/, '');
  const integer = grouped(whole.replace(/^0+(?=\d)/, ''));
  const text = kept ? `${integer}.${kept}` : integer;
  return sign && /[1-9]/.test(`${whole}${kept}`) ? `−${text}` : text;
}

/** "549.000000" → "549.00", grouped: an amount of money to two places, by the margin table's rounding of the text. */
export function moneyText(value: string): string {
  const rounded = twoPlaces(value);
  const match = /^(−?)(\d+)\.(\d\d)$/.exec(rounded);
  return match ? `${match[1]}${grouped(match[2])}.${match[3]}` : rounded;
}

/** A difference with its sign: "50.000000" → "+50.00" (money) or "+500" (other); zero has no sign. */
export function deltaText(value: string, money: boolean): string {
  const text = money ? moneyText(value) : decimalText(value);
  if (isNegative(value) || text.startsWith('−')) return text;
  return /[1-9]/.test(text) ? `+${text}` : text;
}
