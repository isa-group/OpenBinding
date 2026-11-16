import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Both brand palettes of styles/tailwind.css (SPHERE's orange, the defaults of @theme, and OpenBinding's blue, under
// :root[data-brand='openbinding']) must reach WCAG AA for the pairs the interface draws. jsdom cannot paint, so the
// colours are read from the stylesheet and the ratios computed here.

const css = readFileSync(`${process.cwd()}/src/styles/tailwind.css`, 'utf8');

function declarations(block: string): Map<string, string> {
  return new Map([...block.matchAll(/--(color-tp-[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

function blockAfter(marker: string): string {
  const start = css.indexOf('{', css.indexOf(marker));
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unbalanced block after ${marker}`);
}

const sphere = declarations(blockAfter('@theme {'));
const openbinding = new Map([...sphere, ...declarations(blockAfter(":root[data-brand='openbinding']"))]);

function resolve(palette: Map<string, string>, name: string): string {
  let value = palette.get(name);
  for (let hops = 0; value?.startsWith('var(') && hops < 5; hops += 1) value = palette.get(value.slice(6, -1));
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`--${name} does not resolve to a hex colour: ${value}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Small text: 4.5:1. Each pair is [foreground, background]. */
const TEXT: Array<[string, string]> = [
  ['color-tp-ink', 'color-tp-canvas'],
  ['color-tp-slate', 'color-tp-canvas'],
  ['color-tp-steel', 'color-tp-canvas'],
  ['color-tp-steel', 'color-tp-surface'],
  ['color-tp-slate', 'color-tp-cream'],
  ['color-tp-accent', 'color-tp-canvas'],
  ['color-tp-accent', 'color-tp-surface'],
  ['color-tp-accent', 'color-tp-cream'],
  ['color-tp-accent-hover', 'color-tp-canvas'],
  ['color-tp-primary-deep', 'color-tp-canvas'],
  ['color-tp-link', 'color-tp-canvas'],
  ['color-tp-link', 'color-tp-surface-cream'],
  ['color-tp-on-primary', 'color-tp-accent'],
  ['color-tp-on-primary', 'color-tp-accent-hover'],
  ['color-tp-on-primary', 'color-tp-primary-deep'],
  ['color-tp-ink', 'color-tp-cream-deeper'],
  ['color-tp-success-text', 'color-tp-severity-success-bg'],
  ['color-tp-warning-text', 'color-tp-severity-warning-bg'],
  ['color-tp-error-text', 'color-tp-severity-error-bg'],
  ['color-tp-info-text', 'color-tp-severity-info-bg'],
];

/** Fills, borders, icons and large text: 3:1 against the page. */
const NON_TEXT: Array<[string, string]> = [
  ['color-tp-primary', 'color-tp-canvas'],
  ['color-tp-accent', 'color-tp-cream'],
];

for (const [name, palette] of [['sphere', sphere], ['openbinding', openbinding]] as const) {
  describe(`the ${name} palette`, () => {
    it.each(TEXT)('sets %s on %s at 4.5:1 or more', (foreground, background) => {
      expect(ratio(resolve(palette, foreground), resolve(palette, background))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(NON_TEXT)('draws %s on %s at 3:1 or more', (foreground, background) => {
      expect(ratio(resolve(palette, foreground), resolve(palette, background))).toBeGreaterThanOrEqual(3);
    });
  });
}

describe('the two palettes', () => {
  it('keep SPHERE orange as the default and OpenBinding blue as the alternative', () => {
    expect(resolve(sphere, 'color-tp-primary')).toBe('#fa520f');
    expect(resolve(sphere, 'color-tp-primary-deep')).toBe('#cc3a05');
    expect(resolve(openbinding, 'color-tp-primary')).toBe('#0077b6');
  });

  it('give the OpenBinding palette only names the theme already has', () => {
    for (const key of declarations(blockAfter(":root[data-brand='openbinding']")).keys()) expect(sphere.has(key)).toBe(true);
  });
});
