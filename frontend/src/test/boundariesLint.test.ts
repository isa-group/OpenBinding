import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** Lints text with the real eslint.config.js; the imported files are real pages so the resolver finds them. */
const eslint = new ESLint({ cwd: process.cwd() });
const lint = async (filePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath: `${process.cwd()}/${filePath}` });
  return result;
};
const boundaries = (messages: { ruleId: string | null }[]) => messages.filter((m) => m.ruleId?.startsWith('boundaries/'));

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
