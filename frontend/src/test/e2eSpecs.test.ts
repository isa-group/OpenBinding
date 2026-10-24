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

const configs = [`${root}/playwright.config.ts`, `${root}/playwright.live.config.ts`, `${root}/playwright.acceptance.config.ts`];
const liveFiles = ts.sys.readDirectory(live, ['.ts']);
const rootNames = [...ts.sys.readDirectory(e2e, ['.ts']), ...configs];
const program = ts.createProgram({ rootNames, options });
const own = (name: string) => name.startsWith(`${e2e}/`) || configs.includes(name);
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
    // A listed configuration that does not exist is not reported as a diagnostic of an own file, so check it is in the program.
    for (const config of configs) expect(program.getSourceFile(config), config).toBeDefined();
    expect(diagnostics).toEqual([]);
  }, 180_000);

  describe('the live project', () => {
    const specs = liveFiles.filter((name) => name.endsWith('.spec.ts'));

    it('covers login, navigation, the case, a job, the viewer, the outsider, the plan page and the visual QA', () => {
      expect(specs.map((name) => name.replace(`${live}/`, ''))).toEqual([
        '01-login.spec.ts', '02-navigation.spec.ts', '03-case-simple-seq.spec.ts', '04-job-random-search.spec.ts',
        '05-viewer-read-only.spec.ts', '06-outsider-no-access.spec.ts', '07-plan-and-consoles.spec.ts', 'visual-qa.spec.ts',
      ]);
      for (const name of specs) expect(read(name), name).toMatch(/\btest\(|\btest\.describe\(/);
    });

    it('takes the synthetic users from the lab and the password from the environment only', () => {
      const support = read(`${live}/support.ts`);
      // From a workstation LAB_SEED_PASSWORD; inside the `e2e` service of the lab, DEMO_SEED_PASSWORD (the name compose.lab.json uses).
      const either = 'process.env.LAB_SEED_PASSWORD || process.env.DEMO_SEED_PASSWORD';
      expect(support).toContain(either);
      for (const user of ['lab-owner', 'lab-member', 'lab-viewer', 'lab-outsider']) expect(support).toContain(user);
      for (const name of liveFiles) {
        const text = read(name);
        // No literal password, no other fallback for the variables, and nothing that reads a .env file.
        expect(text, name).not.toMatch(/password['"]?\s*[:=]\s*['"`]/i);
        expect(text.replace(either, ''), name).not.toMatch(/(LAB|DEMO)_SEED_PASSWORD\s*(\?\?|\|\|)/);
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

    it('has a configuration for the lab: no web server, one worker, a desktop and a mobile project, Chromium without a sandbox', () => {
      const config = read(`${root}/playwright.live.config.ts`);
      expect(config).toContain("testDir: './e2e/live'");
      expect(config).toContain("process.env.BASE_URL ?? 'http://web:8080'");
      expect(config).toContain("process.env.E2E_RESULTS_DIR ?? '/results'");
      expect(config).toMatch(/workers: 1\b/);
      expect(config).toContain("trace: 'retain-on-failure'");
      expect(config).toMatch(/name: 'desktop'[\s\S]*width: 1280, height: 800/);
      expect(config).toMatch(/name: 'mobile'[\s\S]*width: 390, height: 844[\s\S]*hasTouch: true/);
      expect(config).toContain("'--no-sandbox'");
      expect(config).toContain("'--disable-dev-shm-usage'");
      expect(config).not.toContain('webServer');
      // The mocked specs keep their own configuration, which the lab file must not have changed.
      expect(read(`${root}/playwright.config.ts`)).not.toContain('E2E_RESULTS_DIR');
    });

    it('renders the summary as an image after summary.mjs and before done, and never fails the run', () => {
      const script = ts.sys.readFile(`${live}/summary-image.mjs`) ?? '';
      expect(script).toContain("import { chromium } from '@playwright/test'");
      expect(script).toContain("import { aggregate } from './summary.mjs'");
      expect(script).toContain('screenshots/_summary.png');
      expect(script).toContain('fullPage: true');
      expect(script).toContain('width: 1200');
      expect(script).toContain("'--no-sandbox'");
      expect(script).toContain("'--disable-dev-shm-usage'");
      expect(script).toContain('process.exitCode = 0');
      expect(ts.sys.readFile(`${live}/summary.mjs`) ?? '').toContain('export function aggregate');
      const run = ts.sys.readFile(`${live}/run.sh`) ?? '';
      const at = (text: string) => run.indexOf(text);
      expect(at('summary.mjs')).toBeGreaterThan(-1);
      expect(at('summary-image.mjs')).toBeGreaterThan(at('summary.mjs'));
      expect(at('touch "$RESULTS/done"')).toBeGreaterThan(at('summary-image.mjs'));
    });

    it('measures every screen at both sizes: overflow, console, pageerror, 5xx, landmark, touch targets, clipped text, images', () => {
      const qa = read(`${live}/visual-qa.spec.ts`);
      expect(qa).toContain('scrollWidth');
      expect(qa).toContain('innerWidth');
      expect(qa).toMatch(/message\.type\(\) === 'error'/);
      expect(qa).toContain("page.on('pageerror'");
      expect(qa).toMatch(/status >= 500/);
      expect(qa).toContain('main, [role="main"]');
      expect(qa).toMatch(/MIN_TARGET_PX = 24/);
      expect(qa).toContain('clipped');
      expect(qa).toContain('brokenImages');
      expect(qa).toContain('${RESULTS_DIR}/screenshots/');
      expect(qa).toMatch(/VQA viewport=/);
      // The screens the QA walks.
      for (const screen of ["slug: 'login'", "slug: 'panel'", "slug: 'organization-projects'", "slug: 'project'", "slug: 'case'", "slug: 'jobs'",
        "slug: 'job-result'", "slug: 'plan-permissions'", "slug: 'team-organization'"]) {
        expect(qa, screen).toContain(screen);
      }
      // A viewer is not offered a way to start a run.
      expect(qa).toContain('Send run');
      expect(qa).toContain('starting a run needs MEMBER');
    });
  });
});
