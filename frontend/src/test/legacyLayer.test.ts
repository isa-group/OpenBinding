import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every stylesheet other than styles/tailwind.css belongs to a screen not yet drawn with Tailwind, and its rules sit in the
// `legacy` cascade layer: above preflight, below SPHERE's components and the utilities. An unlayered rule would beat every
// layered one, whatever its specificity, so a stylesheet that forgets the wrapper silently overrides the Tailwind screens.

const root = join(process.cwd(), 'src');
const sheets = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.css'))
  .map(name => name.replaceAll('\\', '/'));

/** The sheet without its leading comments and `@import` lines, which must come before any layer block. */
function body(text: string): string {
  return text.replace(/^(\s+|\/\*[\s\S]*?\*\/|@import[^;]+;)*/, '');
}

describe('the legacy cascade layer', () => {
  it('reads the stylesheets', () => {
    expect(sheets).toContain('styles/tailwind.css');
    expect(sheets.length).toBeGreaterThan(10);
  });

  it('opens with the layer order, with legacy between base and components', () => {
    const text = body(readFileSync(join(root, 'styles/tailwind.css'), 'utf8'));
    expect(
      text.startsWith(
        '@layer theme, base, legacy, components, pricing-renderer, pricing-renderer.theme, utilities;'
      )
    ).toBe(true);
  });

  it('wraps every other stylesheet whole in @layer legacy', () => {
    const unlayered = sheets
      .filter(name => name !== 'styles/tailwind.css')
      .filter(name => {
        const text = body(readFileSync(join(root, name), 'utf8')).trimEnd();
        return !text.startsWith('@layer legacy {') || !text.endsWith('}');
      });
    expect(unlayered).toEqual([]);
  });
});
