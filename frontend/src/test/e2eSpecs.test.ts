import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * The Playwright specs cannot run where this suite runs (no browser), and `tsc -b` only covers `src`. This compiles them with the
 * TypeScript API, so a spec that does not type-check, or one that reads a password from anywhere but the environment, fails here.
 * `playwright test --list` is the other half of that check, where the binary and a browser exist.
 */

// Under vitest the module URL is served as `/@fs/<absolute path>`.
const root = ts.sys.resolvePath(new URL('../..', import.meta.url).pathname.replace(/^\/@fs/, '')).replace(/\/+$/, '');
const e2e = `${root}/e2e`;
const live = `${e2e}/live`;

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: ['node'],
  typeRoots: [`${root}/node_modules/@types`],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
};

const liveFiles = ts.sys.readDirectory(live, ['.ts']);
const rootNames = [...ts.sys.readDirectory(e2e, ['.ts']), `${root}/playwright.config.ts`];
const program = ts.createProgram({ rootNames, options });
const own = (name: string) => name.startsWith(`${e2e}/`) || name === `${root}/playwright.config.ts`;
const diagnostics = ts.getPreEmitDiagnostics(program)
  .filter((item) => item.file !== undefined && own(item.file.fileName))
  .map((item) => {
    const where = item.file ? item.file.getLineAndCharacterOfPosition(item.start ?? 0) : { line: 0, character: 0 };
    return `${item.file?.fileName.replace(`${root}/`, '')}:${where.line + 1} TS${item.code} ${ts.flattenDiagnosticMessageText(item.messageText, ' ')}`;
  });

const read = (name: string) => program.getSourceFile(name)?.text ?? '';

describe('the Playwright specs', () => {
  it('type-check: the live project, the mocked ones and the configuration', () => {
    // Guards against a path that matches nothing, which would make "no diagnostics" mean nothing.
    expect(liveFiles.length).toBeGreaterThanOrEqual(8);
    expect(rootNames.length).toBeGreaterThan(liveFiles.length);
    expect(program.getSourceFile(`${live}/support.ts`)).toBeDefined();
    expect(diagnostics).toEqual([]);
  }, 180_000);

  describe('the live project', () => {
    const specs = liveFiles.filter((name) => name.endsWith('.spec.ts'));

    it('covers login, navigation, the case, a job, the viewer, the outsider and the plan page', () => {
      expect(specs.map((name) => name.replace(`${live}/`, ''))).toEqual([
        '01-login.spec.ts', '02-navigation.spec.ts', '03-case-simple-seq.spec.ts', '04-job-random-search.spec.ts',
        '05-viewer-read-only.spec.ts', '06-outsider-no-access.spec.ts', '07-plan-and-consoles.spec.ts',
      ]);
      for (const name of specs) expect(read(name), name).toMatch(/\btest\(|\btest\.describe\(/);
    });

    it('takes the synthetic users from the lab and the password from the environment only', () => {
      const support = read(`${live}/support.ts`);
      expect(support).toContain('process.env.LAB_SEED_PASSWORD');
      for (const user of ['lab-owner', 'lab-member', 'lab-viewer', 'lab-outsider']) expect(support).toContain(user);
      for (const name of liveFiles) {
        const text = read(name);
        // No literal password, no fallback for the variable, and nothing that reads a .env file.
        expect(text, name).not.toMatch(/password['"]?\s*[:=]\s*['"`]/i);
        expect(text, name).not.toMatch(/LAB_SEED_PASSWORD\s*(\?\?|\|\|)/);
        expect(text, name).not.toMatch(/['"`][^'"`]*\.env['"`]|dotenv|readFile/);
      }
    });

    it('takes screenshots at 1440x900 and 390x844 into the output directory of the run', () => {
      const support = read(`${live}/support.ts`);
      expect(support).toMatch(/width: 1440, height: 900/);
      expect(support).toMatch(/width: 390, height: 844/);
      expect(support).toContain('testInfo.outputPath');
    });

    it('is a project of its own, against PLAYWRIGHT_BASE_URL and http://localhost:18100 by default', () => {
      const config = read(`${root}/playwright.config.ts`);
      expect(config).toContain("name: 'live'");
      expect(config).toContain('process.env.PLAYWRIGHT_BASE_URL ?? \'http://localhost:18100\'');
      expect(config).toContain("testIgnore: '**/live/**'");
    });
  });
});
