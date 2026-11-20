import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * The Playwright specs cannot run where this suite runs (no browser), and `tsc -b` only covers `src`. This compiles them with the
 * TypeScript API, so a spec that does not type-check, or one that reads a password from anywhere but the environment, fails here.
 * `playwright test --list` is the other half of that check, where the binary and a browser exist.
 */

// Under vitest the module URL is served as `/@fs/<absolute path>`.
const root = ts.sys
  .resolvePath(new URL('../..', import.meta.url).pathname.replace(/^\/@fs/, ''))
  .replace(/\/+$/, '');
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

const configs = [
  `${root}/playwright.config.ts`,
  `${root}/playwright.live.config.ts`,
  `${root}/playwright.acceptance.config.ts`,
  `${root}/playwright.identity.config.ts`,
];
const liveFiles = ts.sys.readDirectory(live, ['.ts']);
const rootNames = [...ts.sys.readDirectory(e2e, ['.ts']), ...configs];
const program = ts.createProgram({ rootNames, options });
const own = (name: string) => name.startsWith(`${e2e}/`) || configs.includes(name);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter(item => item.file !== undefined && own(item.file.fileName))
  .map(item => {
    const where = item.file
      ? item.file.getLineAndCharacterOfPosition(item.start ?? 0)
      : { line: 0, character: 0 };
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

  it('walks each F2a journey closed so far in a mocked spec of its own: J1 derive, seal and compare; J2 showcase and fork; J5 evolution; J6 language', () => {
    const journeys = ts.sys
      .readDirectory(e2e, ['.ts'], undefined, undefined, 1)
      .map(name => name.replace(`${e2e}/`, ''))
      .filter(name => name.startsWith('f2a-'));
    expect(journeys.sort()).toEqual([
      'f2a-derive-seal-compare.spec.ts',
      'f2a-evolution.spec.ts',
      'f2a-language.spec.ts',
      'f2a-showcase-fork.spec.ts',
    ]);
    for (const name of journeys)
      expect(read(`${e2e}/${name}`), name).toMatch(/\btest\.describe\('J\d+ · /);
  });

  it('walks each F3 journey closed so far in a mocked spec of its own: J1 and J2 SPHERE candidates; J3 connections; J4 upstream plans and the offering', () => {
    const journeys = ts.sys
      .readDirectory(e2e, ['.ts'], undefined, undefined, 1)
      .map(name => name.replace(`${e2e}/`, ''))
      .filter(name => name.startsWith('f3-'));
    expect(journeys.sort()).toEqual([
      'f3-connections.spec.ts',
      'f3-sphere-candidates.spec.ts',
      'f3-upstream.spec.ts',
    ]);
    for (const name of journeys)
      expect(read(`${e2e}/${name}`), name).toMatch(/\btest\.describe\('J\d+ · /);
  });

  it('walks each F2b journey in a mocked spec of its own: J3 the problem editor; J4 study front to compositions', () => {
    const journeys = ts.sys
      .readDirectory(e2e, ['.ts'], undefined, undefined, 1)
      .map(name => name.replace(`${e2e}/`, ''))
      .filter(name => name.startsWith('f2b-'));
    expect(journeys.sort()).toEqual(['f2b-problem-editor.spec.ts', 'f2b-study-front.spec.ts']);
    for (const name of journeys)
      expect(read(`${e2e}/${name}`), name).toMatch(/\btest\.describe\('J\d+ · /);
  });

  describe('the SCORETech Identity walks', () => {
    const identity = `${e2e}/identity`;
    const specs = ts.sys
      .readDirectory(identity, ['.ts'])
      .filter(name => name.endsWith('.spec.ts'))
      .map(name => name.replace(`${identity}/`, ''));

    it('live in e2e/identity, numbered apart from e2e/live, and run only by their own configuration', () => {
      expect(specs.sort()).toEqual(['01-gateway.spec.ts', '02-screens.spec.ts']);
      const config = read(`${root}/playwright.identity.config.ts`);
      expect(config).toContain("testDir: './e2e/identity'");
      expect(config).toMatch(/workers: 1\b/);
      expect(config).not.toContain('webServer');
      expect(config).toContain("process.env.BASE_URL ?? 'http://localhost:18198'");
      expect(read(`${root}/playwright.config.ts`)).toContain(
        "testIgnore: ['**/live/**', '**/identity/**']"
      );
    });

    it('walk the gateway phase by phase: bootstrap, the main phase, a native registration, its grant and the rollback', () => {
      const spec = read(`${identity}/01-gateway.spec.ts`);
      for (const tag of ['@bootstrap', '@signup', '@granted', '@rollback'])
        expect(spec).toContain(`'${tag} `);
      for (const role of ['member', 'research', 'clash', 'squat', 'norole'])
        expect(spec).toContain(`'${role}: `);
    });

    it('walk the screens: the username screen, the renewal, two tabs, the error pages and the rollback', () => {
      const spec = read(`${identity}/02-screens.spec.ts`);
      for (const tag of ['@screens J1, J2', '@screens J3', '@screens J4', '@rollback J8'])
        expect(spec).toContain(`'${tag}`);
      expect(spec).toContain('identity-username-409');
      expect(spec).toContain('identity-error-${code}');
    });

    it('read codes from the lab Mailpit and never type a literal password or address of a real domain', () => {
      const support = read(`${identity}/support.ts`);
      expect(support).toContain('/api/v1/message/');
      expect(support).toMatch(/\[0-9\]\{6\}/);
      for (const name of specs
        .map(spec => `${identity}/${spec}`)
        .concat(`${identity}/support.ts`)) {
        const text = read(name);
        expect(text, name).not.toMatch(/password['"]?\s*[:=]\s*['"`]/i);
        expect(text, name).not.toMatch(/@us\.es\b/);
      }
    });
  });

  describe('the live project', () => {
    const specs = liveFiles.filter(name => name.endsWith('.spec.ts'));

    it('covers login, navigation, the upload-run-study walk, a job, the viewer, the outsider, the plan page, J1 to J4, SPHERE candidates, the visual QA and the palette sweep', () => {
      expect(specs.map(name => name.replace(`${live}/`, ''))).toEqual([
        '01-login.spec.ts',
        '02-navigation.spec.ts',
        '03-upload-run-study.spec.ts',
        '04-job-random-search.spec.ts',
        '05-viewer-read-only.spec.ts',
        '06-outsider-no-access.spec.ts',
        '07-plan-and-consoles.spec.ts',
        '08-derive-seal-compare.spec.ts',
        '09-public-fork.spec.ts',
        '10-problem-editor.spec.ts',
        '11-study-front.spec.ts',
        '12-sphere-candidates.spec.ts',
        'visual-qa.spec.ts',
        'visual-sweep.spec.ts',
      ]);
      for (const name of specs) expect(read(name), name).toMatch(/\btest\(|\btest\.describe\(/);
    });

    it('walks J1 and J2 against the lab: derive, seal and compare on lab-main; the public list, a composition page and a fork from lab-other', () => {
      const j1 = read(`${live}/08-derive-seal-compare.spec.ts`);
      expect(j1).toMatch(/test\.describe\('live · J1 /);
      for (const step of [
        "'Keep as composition'",
        "'Visual editor'",
        "'Publish to OpenBinding'",
        '/Publish version/',
        "'Compare with previous'",
        "'The text of 1.0.0 and 1.1.0'",
      ]) {
        expect(j1, step).toContain(step);
      }
      const j2 = read(`${live}/09-public-fork.spec.ts`);
      expect(j2).toMatch(/test\.describe\('live · J2 /);
      for (const step of [
        "'/compositions'",
        "'Fork this composition'",
        "'Fork without the problem'",
        "'Fork as new composition'",
        "'Page not found'",
      ]) {
        expect(j2, step).toContain(step);
      }
    });

    it('walks J3 and J4 against the lab: a template edited in the matrix, refused by the compiler, fixed and saved; a study front derived into a composition', () => {
      const j3 = read(`${live}/10-problem-editor.spec.ts`);
      expect(j3).toMatch(/test\.describe\('live · J3 /);
      for (const step of [
        "'demo/16_json_complete'",
        "'Candidates of each task'",
        "'pe-check-status'",
        "'candidates.json source'",
        "'Save as a new problem'",
        "'Run this version'",
      ]) {
        expect(j3, step).toContain(step);
      }
      const j4 = read(`${live}/11-study-front.spec.ts`);
      expect(j4).toMatch(/test\.describe\('live · J4 /);
      for (const step of [
        "'Problem versions'",
        "'Run study'",
        "'Pareto front'",
        "'Derive this point'",
        "'Derive 1 composition'",
      ]) {
        expect(j4, step).toContain(step);
      }
    });

    it('walks F3 against the lab and live SPHERE: two pinned pricings into a problem, the drawn upstream plan and storefront, a registry, a refused key', () => {
      const f3 = read(`${live}/12-sphere-candidates.spec.ts`);
      expect(f3).toMatch(/test\.describe\('live · F3 /);
      for (const step of [
        "'6ade36454b2b5b01c587db3d'",
        "'6ade2f3b4b2b5b01c587d8f5'",
        'SPHERE is busy; preview again in',
        "'Open in SPHERE'",
        "'score-mirror'",
        "'SPHERE API key'",
      ]) {
        expect(f3, step).toContain(step);
      }
    });

    it('sweeps every screen of the route table in both palettes at 1440x900 and 390x844, a 375 px pass and a dark OS', () => {
      const sweep = read(`${live}/visual-sweep.spec.ts`);
      expect(sweep).toContain('readScreenLines()');
      expect(sweep).toContain("['sphere', 'openbinding']");
      expect(sweep).toMatch(/width: 1440, height: 900/);
      expect(sweep).toMatch(/width: 390, height: 844/);
      expect(sweep).toMatch(/width: 375/);
      expect(sweep).toContain("colorScheme: 'dark'");
      for (const screen of ['sphere-wizard-pricing', 'sphere-wizard-preview', 'org-connections'])
        expect(sweep, screen).toContain(screen);
    });

    it('takes the synthetic users from the lab and the password from the environment only', () => {
      const support = read(`${live}/support.ts`);
      // From a workstation LAB_SEED_PASSWORD; inside the `e2e` service of the lab, DEMO_SEED_PASSWORD (the name compose.lab.json uses).
      const either = 'process.env.LAB_SEED_PASSWORD || process.env.DEMO_SEED_PASSWORD';
      expect(support).toContain(either);
      for (const user of ['lab-owner', 'lab-member', 'lab-viewer', 'lab-outsider'])
        expect(support).toContain(user);
      for (const name of liveFiles) {
        const text = read(name);
        // No literal password, no other fallback for the variables, and nothing that reads a .env file.
        expect(text, name).not.toMatch(/password['"]?\s*[:=]\s*['"`]/i);
        expect(text.replace(either, ''), name).not.toMatch(
          /(LAB|DEMO)_SEED_PASSWORD\s*(\?\?|\|\|)/
        );
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
      expect(config).toContain("process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:18100'");
      expect(config).toContain("testIgnore: ['**/live/**', '**/identity/**']");
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
      // One directory per palette (VISUAL_BRAND), the plain one when the deployment's default is looked at.
      expect(qa).toContain("`${RESULTS_DIR}/screenshots${BRAND ? `-${BRAND}` : ''}`");
      expect(qa).toContain('${SCREENSHOTS}/${viewport}-${stop.slug}.png');
      expect(qa).toMatch(/VQA viewport=/);
      // The screens the QA walks.
      for (const screen of [
        "slug: 'login'",
        "slug: 'panel'",
        "slug: 'organization'",
        "slug: 'cases'",
        "slug: 'case'",
        "slug: 'jobs'",
        "slug: 'job-result'",
        "slug: 'plan-permissions'",
        "slug: 'team-organization'",
        "slug: 'pricing'",
        "slug: 'engine-card'",
      ]) {
        expect(qa, screen).toContain(screen);
      }
      // The composition screens: the list, every tab of the card page and the two views of the version comparison, the public list, the
      // showcase and Language for a visitor, the viewer's list and detail, and the standalone editor (code, visual, and on mobile
      // its Problems tab).
      for (const screen of [
        "slug: 'compositions'",
        "slug: 'composition-overview'",
        "slug: 'composition-editor'",
        "slug: 'composition-editor-visual'",
        "pane('composition-editor-problems'",
        "slug: 'composition-versions'",
        "slug: 'composition-versions-compare'",
        "slug: 'composition-versions-file'",
        "slug: 'composition-analytics'",
        "slug: 'composition-configuration'",
        "slug: 'composition-settings'",
        "slug: 'public-compositions'",
        "slug: 'showcase'",
        "slug: 'language'",
        "slug: 'viewer-compositions'",
        "slug: 'viewer-composition'",
      ]) {
        expect(qa, screen).toContain(screen);
      }
      // The problem screens (F2b): the Candidates and Compositions tabs, the problem editor pane by pane (and on mobile its
      // Engines and Problems tabs), the run presets section and the study front.
      for (const screen of [
        "slug: 'problem-candidates'",
        "slug: 'problem-compositions'",
        "slug: 'problem-editor'",
        "pane('problem-editor-candidates'",
        "pane('problem-editor-rules'",
        "pane('problem-editor-files'",
        "pane('problem-editor-forms'",
        "pane('problem-editor-engines'",
        "pane('problem-editor-problems'",
        "slug: 'presets'",
        "slug: 'study-front'",
      ]) {
        expect(qa, screen).toContain(screen);
      }
      // F3: a SPHERE problem's Candidates, the wizard's steps, a composition drawn from snapshots and the Connections tab.
      for (const screen of [
        "slug: 'sphere-candidates'",
        'sphere-wizard-',
        "slug: 'sphere-composition'",
        "slug: 'connections'",
      ])
        expect(qa, screen).toContain(screen);
      // A viewer is not offered a way to start a run.
      expect(qa).toContain('Send run');
      expect(qa).toContain('starting a run needs MEMBER');
    });
  });

  it('keeps the 404-parity sweep over every kind of resource address', () => {
    const sweep = read(`${e2e}/not-found-parity.spec.ts`);
    for (const address of [
      '/orgs/',
      '/compositions/',
      '/p/',
      '/engines/',
      '/problems/',
      '/runs/',
      '/studies/',
      '/me/engines/',
      '/admin',
    ])
      expect(sweep, address).toContain(`'${address}`);
  });
});
