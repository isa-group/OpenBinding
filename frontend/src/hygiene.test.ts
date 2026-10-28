import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What the shipped interface must not carry over from the prototype or from the old dark theme. The files read are the application's own
// sources and styles, and the shared fixtures of the tests (src/test/fixtures): those stand in for the gateway but are shown in the
// gallery, so they name nobody from the prototype either. Only the tests themselves and the test kits are free to name anybody.

const files = import.meta.glob(['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const shipped = Object.entries(files).filter(([path]) => !/(\/src\/test\/setup\.ts$|testKit\.tsx?$|[Tt]estUtils\.tsx?$)/.test(path));
const isFixture = (path: string) => /(\/src\/test\/fixtures\/|[Ff]ixtures?\.ts$)/.test(path);

const grep = (pattern: RegExp, only: RegExp = /./, entries: ReadonlyArray<[string, string]> = shipped) => entries
  .filter(([path]) => only.test(path))
  .flatMap(([path, text]) => text.split('\n').map((line, index) => ({ at: `${path}:${index + 1}`, line })).filter(({ line }) => pattern.test(line)))
  .map(({ at, line }) => `${at}  ${line.trim()}`);

/**
 * The stylesheets as they are on disk. Vitest hands a `?raw` stylesheet over empty (it does not process CSS), so the rules about
 * colours and type read them with Node's own file system.
 */
function stylesheets(): Array<[string, string]> {
  // This file sits in src/; the tests run from frontend/, which is the fallback if the runner does not say where the file is.
  const root = import.meta.dirname ?? join(process.cwd(), 'src');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.css'))
    .map((name): [string, string] => [`/src/${name.replaceAll('\\', '/')}`, readFileSync(join(root, name), 'utf8')]);
}

describe('the interface is light and carries no prototype persona', () => {
  it('reads files', () => {
    expect(shipped.length).toBeGreaterThan(100);
  });

  it('has no dark theme: no colour-scheme media query, no theme attribute, no dark colour scheme', () => {
    expect(grep(/prefers-color-scheme|data-theme|color-scheme:\s*(dark|light dark)/)).toEqual([]);
  });

  it('has no translucent white on white left over from dark surfaces', () => {
    expect(grep(/rgba\(255,\s*255,\s*255,\s*0?\.(0\d*|1\d*)\)/, /\.css$/)).toEqual([]);
  });

  it('names no persona of the prototype in a placeholder, a label, a sample or a fixture', () => {
    const persona = /(luc[ií]a|iker|marco|sof[ií]a|nora)[.\- ](vega|mora|d[ií]az|rey|campos)|baja\.demo|ShellSim|persona switcher/i;
    expect(grep(persona)).toEqual([]);
  });

  it('keeps the shared fixtures in src/test/fixtures, in English', () => {
    const fixtures = shipped.filter(([path]) => /\/src\/test\/fixtures\//.test(path));
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(grep(/[áéíóúñÁÉÍÓÚÑ¿¡]/, /./, fixtures)).toEqual([]);
    expect(grep(/\b(flujo|checkout-comparativa|semillas|borrador|autenticar|pago-tarjeta)\b/i, /./, fixtures)).toEqual([]);
  });

  it('colours the interface with the design tokens, not with hex values of its own', () => {
    const hex = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/;
    const sources = shipped.filter(([path]) => !/\.css$/.test(path));
    const owned = [...sources, ...stylesheets()].filter(([path]) => !isFixture(path) && !/\/src\/styles\/globals\.css$/.test(path));
    expect(owned.length).toBeGreaterThan(100);
    expect(grep(hex, /\.(css|tsx?)$/, owned)).toEqual([]);
  });

  it('falls back from PP Editorial Old to Georgia, never to Times New Roman first', () => {
    const css = stylesheets().find(([path]) => path.endsWith('/src/styles/globals.css'))?.[1] ?? '';
    const stack = /--font-display:\s*([^;]+);/.exec(css)?.[1] ?? '';
    const families = stack.split(',').map((family) => family.trim().replace(/^["']|["']$/g, ''));
    expect(families[0]).toBe('PP Editorial Old');
    expect(families[1]).toBe('Georgia');
    const times = families.indexOf('Times New Roman');
    expect(times === -1 || times > families.indexOf('Georgia')).toBe(true);
    expect(stylesheets().filter(([, text]) => /Times New Roman/.test(text)).map(([path]) => path)).toEqual([]);
    expect(grep(/Times New Roman/)).toEqual([]);
  });
});
