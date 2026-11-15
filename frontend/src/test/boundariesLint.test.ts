import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Lints text with the real eslint.config.js. The linted file needs no existence, but what it imports must resolve: pages import
 * real pages, and the new layers import the slices under src/test/fixtures/boundaries/src/<layer>/alpha, whose paths end in
 * src/<layer>/<slice> like the real ones, so the layer rules classify them the same way.
 */
const eslint = new ESLint({ cwd: process.cwd() });
const lint = async (filePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: `${process.cwd()}/${filePath}` });
  return result;
};
const boundaries = (messages: { ruleId: string | null }[]) => messages.filter((m) => m.ruleId?.startsWith('boundaries/'));

/** An import of `layer`'s fixture slice from a file at `from` (two folders below src, like every slice file). */
const importing = (layer: string) => `import { slice } from '../../test/fixtures/boundaries/src/${layer}/alpha';\nexport const used = slice;\n`;

const errorsOf = async (from: string, code: string) => {
  const result = await lint(from, code);
  const found = boundaries(result.messages);
  return { found, errors: found.filter((m) => (m as { severity?: number }).severity === 2).length };
};

describe('boundaries rule on page imports', () => {
  it('warns, without failing, on an import from one page into another', async () => {
    const result = await lint('src/pages/About/About.tsx', "import { Account } from '../Account/Account';\nexport const page = Account;\n");
    const found = boundaries(result.messages);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((m) => (m as { severity?: number }).severity === 1)).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('does not warn on an import inside the same page', async () => {
    const result = await lint('src/pages/About/About.tsx', "import * as model from './aboutModel';\nexport const page = model;\n");
    expect(boundaries(result.messages)).toEqual([]);
  });
});

describe('boundaries rule on the new layers', () => {
  it.each([
    ['a widget', 'src/widgets/probe/Probe.tsx', 'features'],
    ['an entity', 'src/entities/probe/probe.ts', 'widgets'],
    ['an entity', 'src/entities/probe/probe.ts', 'features'],
    ['a feature', 'src/features/probe/probe.ts', 'features'],
    ['a shared module', 'src/shared/probe/probe.ts', 'entities'],
  ])('fails when %s (%s) imports from %s', async (_who, from, layer) => {
    const { errors } = await errorsOf(from, importing(layer));
    expect(errors).toBeGreaterThan(0);
  });

  it('fails when a renderer mode imports the derive dialog: the page mounts it and the mode takes a callback', async () => {
    const { errors } = await errorsOf(
      'src/widgets/composition-renderer/modes/probe.tsx',
      "import { DeriveCompositionDialog } from '../../../features/derive/DeriveCompositionDialog';\nexport const used = DeriveCompositionDialog;\n",
    );
    expect(errors).toBeGreaterThan(0);
  });

  it('fails when a feature imports a page', async () => {
    const { errors } = await errorsOf('src/features/probe/probe.ts', "import { About } from '../../pages/About/About';\nexport const used = About;\n");
    expect(errors).toBeGreaterThan(0);
  });

  it.each([
    ['a widget', 'src/widgets/probe/Probe.tsx', 'widgets'],
    ['an entity', 'src/entities/probe/probe.ts', 'entities'],
    ['a feature', 'src/features/probe/probe.ts', 'widgets'],
    ['a feature', 'src/features/probe/probe.ts', 'entities'],
    ['a widget', 'src/widgets/probe/Probe.tsx', 'shared'],
  ])('allows %s (%s) to import from %s', async (_who, from, layer) => {
    const { found } = await errorsOf(from, importing(layer));
    expect(found).toEqual([]);
  });

  it('allows the legacy shared folders and imports inside one slice', async () => {
    const legacy = await errorsOf('src/widgets/probe/Probe.tsx', "import { Action } from '../../components/ui/Action';\nexport const used = Action;\n");
    expect(legacy.found).toEqual([]);
    const inside = await errorsOf('src/features/workspace/probe.ts', "import { jobStatus } from './model';\nexport const used = jobStatus;\n");
    expect(inside.found).toEqual([]);
  });
});
