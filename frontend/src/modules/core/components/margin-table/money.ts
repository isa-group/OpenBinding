// The margin table's amounts are the gateway's fixed six-place decimal strings. They are shown to two places by rounding the
// text itself (half up on the third decimal), never by reading them as numbers: the screen computes nothing (plan §2.4, F4
// architecture M). The full value stays in a `title`.

const AMOUNT = /^(-?)(\d+)\.(\d+)$/;

/** Adds one to a string of digits, carrying. */
function increment(digits: string): string {
  const chars = digits.split('');
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (chars[index] !== '9') {
      chars[index] = String.fromCharCode(chars[index].charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[index] = '0';
  }
  return `1${chars.join('')}`;
}

/** Whether the gateway's amount is below zero: `-0.508990` is, `0.000000` is not. */
export function isNegative(amount: string): boolean {
  return /^-/.test(amount) && /[1-9]/.test(amount);
}

/** `-0.508990` → `−0.51`; `11.481010` → `11.48`; a text that is not an amount is returned as it is. */
export function twoPlaces(amount: string): string {
  const match = AMOUNT.exec(amount);
  if (!match) return amount;
  const [, sign, whole, fraction] = match;
  const padded = `${fraction}00`;
  let kept = `${whole}${padded.slice(0, 2)}`;
  if (padded[2] >= '5') kept = increment(kept);
  const integer = kept.slice(0, -2).replace(/^0+(?=\d)/, '') || '0';
  const text = `${integer}.${kept.slice(-2)}`;
  return sign && /[1-9]/.test(kept) ? `−${text}` : text;
}
