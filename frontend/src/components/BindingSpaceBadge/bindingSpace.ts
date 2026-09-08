export function toSuperscript(num: number): string {
  const map: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  };
  return String(num).split('').map((digit) => map[digit] || digit).join('');
}

export function parseBindingSpace(val: string | number): {
  bigVal: bigint;
  formatted: string;
  exact: string;
  log10: number;
  tier: 'micro' | 'small' | 'medium' | 'large' | 'massive';
  tierLabel: string;
  dots: number;
} {
  const str = String(val || '1').trim();
  let bigVal = 1n;
  try {
    bigVal = BigInt(str);
  } catch {
    bigVal = 1n;
  }

  const exact = str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const digits = str.length;
  const leading = parseFloat(str.slice(0, Math.min(digits, 6))) || 1;
  const log10 = Math.max(0, digits - 1 + Math.log10(leading / Math.pow(10, Math.min(digits - 1, 5))));

  let tier: 'micro' | 'small' | 'medium' | 'large' | 'massive' = 'micro';
  let tierLabel = 'Trivial';
  let dots = 1;
  if (bigVal < 100n) {
    tier = 'micro'; tierLabel = 'Trivial'; dots = 1;
  } else if (bigVal < 10000n) {
    tier = 'small'; tierLabel = 'Exhaustive'; dots = 2;
  } else if (bigVal < 1000000000n) {
    tier = 'medium'; tierLabel = 'Moderate'; dots = 3;
  } else if (bigVal < 1000000000000n) {
    tier = 'large'; tierLabel = 'Complex'; dots = 4;
  } else {
    tier = 'massive'; tierLabel = 'Massive'; dots = 4;
  }

  let formatted = '';
  if (bigVal < 10000n) formatted = exact;
  else if (bigVal < 1000000n) formatted = `${(Number(bigVal) / 1000).toFixed(1)}k`;
  else if (bigVal < 1000000000n) formatted = `${(Number(bigVal) / 1000000).toFixed(2)}M`;
  else if (bigVal < 1000000000000n) formatted = `${(Number(bigVal / 1000000n) / 1000).toFixed(2)}B`;
  else {
    const exp = digits - 1;
    const mantissa = (Number(str.slice(0, 4)) / 1000).toFixed(2);
    formatted = `${mantissa} × 10${toSuperscript(exp)}`;
  }

  return { bigVal, formatted, exact, log10, tier, tierLabel, dots };
}
