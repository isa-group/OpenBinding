import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every screen is drawn with Tailwind's utilities and SPHERE's `tp` tokens: styles/tailwind.css is the application's one
// stylesheet (docs/adr/0053-frontend-on-sphere-stack.md). A library's own stylesheet may still be imported from
// node_modules (react-loading-skeleton, bpmn-js, pricing-renderer); a `.css` file of our own may not come back.

const root = join(process.cwd(), 'src');
const sheets = readdirSync(root, { recursive: true, encoding: 'utf8' })
  .filter(name => name.endsWith('.css'))
  .map(name => name.replaceAll('\\', '/'));

/** The sheet without its leading comments, which come before the layer statement. */
function body(text: string): string {
  return text.replace(/^(\s+|\/\*[\s\S]*?\*\/)*/, '');
}

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('one stylesheet', () => {
  it('has no stylesheet under src other than styles/tailwind.css', () => {
    expect(sheets).toEqual(['styles/tailwind.css']);
  });

  it('opens with the layer order, with no legacy layer', () => {
    const text = body(readFileSync(join(root, 'styles/tailwind.css'), 'utf8'));
    expect(
      text.startsWith(
        '@layer theme, base, components, pricing-renderer, pricing-renderer.theme, utilities;'
      )
    ).toBe(true);
    expect(text).not.toMatch(/@layer legacy\b/);
  });

  it('imports no stylesheet of its own from the sources, only the libraries’ ones', () => {
    const own = Object.entries(sources).flatMap(([path, text]) =>
      [...text.matchAll(/import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/g)]
        .map(match => match[1])
        .filter(spec => !(path === '/src/main.tsx' && spec === './styles/tailwind.css'))
        .map(spec => `${path}: ${spec}`)
    );
    expect(own).toEqual([]);
  });
});
