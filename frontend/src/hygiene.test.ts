import { describe, expect, it } from 'vitest';

// What the shipped interface must not carry over from the prototype or from the old dark theme. The files read are the application's own
// sources and styles; fixtures and test kits stand in for the gateway and are free to name anybody.

const files = import.meta.glob(['/src/**/*.{ts,tsx,css}', '!/src/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const shipped = Object.entries(files).filter(([path]) => !/(\/src\/test\/|[Ff]ixtures?\.ts$|testKit\.tsx?$|[Tt]estUtils\.tsx?$)/.test(path));

const grep = (pattern: RegExp, only: RegExp = /./) => shipped
  .filter(([path]) => only.test(path))
  .flatMap(([path, text]) => text.split('\n').map((line, index) => ({ at: `${path}:${index + 1}`, line })).filter(({ line }) => pattern.test(line)))
  .map(({ at, line }) => `${at}  ${line.trim()}`);

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

  it('names no persona of the prototype in a placeholder, a label or a sample', () => {
    const persona = /(luc[ií]a|iker|marco|sof[ií]a|nora)[.\- ](vega|mora|d[ií]az|rey|campos)|ShellSim|persona switcher/i;
    expect(grep(persona)).toEqual([]);
  });
});
