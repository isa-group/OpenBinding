import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Lints text with the real eslint.config.js. The linted file needs no existence, but what it imports must resolve: pages import
 * real pages, and the module rule is tried on the pieces under src/test/fixtures/boundaries/src/modules/, whose paths end in
 * src/modules/<module>/<folder> like the real ones, so the rule classifies them the same way.
 */
const eslint = new ESLint({ cwd: process.cwd() });
const lint = async (filePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: `${process.cwd()}/${filePath}` });
  return result;
};
const boundaries = (messages: { ruleId: string | null }[]) =>
  messages.filter(m => m.ruleId?.startsWith('boundaries/'));

/** An import of a fixture piece (`alpha/api`, `core/utils/alpha`…) from a file three folders below src/modules. */
const importing = (piece: string) =>
  `import { slice } from '../../../test/fixtures/boundaries/src/modules/${piece}';\nexport const used = slice;\n`;

const errorsOf = async (from: string, code: string) => {
  const result = await lint(from, code);
  const found = boundaries(result.messages);
  return { found, errors: found.filter(m => (m as { severity?: number }).severity === 2).length };
};

describe('boundaries rule on page imports', () => {
  it('warns, without failing, on an import from one page into another', async () => {
    const result = await lint(
      'src/pages/About/About.tsx',
      "import { Account } from '../Account/Account';\nexport const page = Account;\n"
    );
    const found = boundaries(result.messages);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(m => (m as { severity?: number }).severity === 1)).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('does not warn on an import inside the same page', async () => {
    const result = await lint(
      'src/pages/About/About.tsx',
      "import * as model from './aboutModel';\nexport const page = model;\n"
    );
    expect(boundaries(result.messages)).toEqual([]);
  });
});

describe('the module rule', () => {
  it.each([
    ['core', 'src/modules/core/utils/probe.ts', 'alpha/api'],
    ['core', 'src/modules/core/utils/probe.ts', 'alpha/utils'],
    ['another module', 'src/modules/beta/utils/probe.ts', 'alpha/utils'],
    ["another module's public folder", 'src/modules/beta/api/probe.ts', 'alpha/utils'],
  ])('fails when %s (%s) imports %s', async (_who, from, piece) => {
    const { errors } = await errorsOf(from, importing(piece));
    expect(errors).toBeGreaterThan(0);
  });

  it('fails when a core renderer mode imports a domain dialog: the page mounts it and the mode takes a callback', async () => {
    const { errors } = await errorsOf(
      'src/modules/core/components/composition-renderer/modes/probe.tsx',
      "import { DeriveCompositionDialog } from '../../../../run/components/derive/DeriveCompositionDialog';\nexport const used = DeriveCompositionDialog;\n"
    );
    expect(errors).toBeGreaterThan(0);
  });

  it.each([
    ['a module', 'src/modules/beta/utils/probe.ts', 'alpha/api'],
    ['a module', 'src/modules/beta/utils/probe.ts', 'alpha/components'],
    ['a module', 'src/modules/beta/utils/probe.ts', 'core/utils/alpha'],
    ['core', 'src/modules/core/hooks/probe.ts', 'core/utils/alpha'],
    ["a module's own public folder", 'src/modules/alpha/api/probe.ts', 'alpha/utils'],
  ])('allows %s (%s) to import %s', async (_who, from, piece) => {
    const { found } = await errorsOf(from, importing(piece));
    expect(found).toEqual([]);
  });

  it('allows the legacy folders, which are not modules, and imports inside one module', async () => {
    const legacy = await errorsOf(
      'src/modules/beta/utils/probe.ts',
      "import { config } from '../../../config';\nexport const used = config;\n"
    );
    expect(legacy.found).toEqual([]);
    const inside = await errorsOf(
      'src/modules/run/components/derive/probe.ts',
      "import { nextMinor } from './deriveModel';\nexport const used = nextMinor;\n"
    );
    expect(inside.found).toEqual([]);
  });
});
