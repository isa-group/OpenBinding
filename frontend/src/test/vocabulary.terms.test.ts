import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import examples from '../content/composition2yaml-examples.json';
import { KINDS } from '../modules/core/utils/composition/document';
import { KIND_LABELS } from '../modules/core/utils/composition/kinds';
import { formatFinding, isTestSupport, scanFiles, wordPattern, type Finding } from './vocabulary';

// The vocabulary of compositions and problems (plan §9: Composition, Problem, Environment, Upstream event, Proposal and Offering;
// the F1 Deferred "vocabulary tests"; D23). The text a source file puts on screen is read by the scanner of `vocabulary.ts`;
// text composed at run time is the acceptance spec's job (`acceptance/ui/navigation/vocabulary-text.spec.ts`).

/** The terms the screens use for the ideas of the platform: English, and fixed. Each is defined in `docs/GLOSSARY.md`. */
const GLOSSARY = [
  'Composition',
  'Problem',
  'Environment',
  'Upstream event',
  'Proposal',
  'Offering',
  'Version',
  'Evaluation',
  'Verified',
  'Declared',
  'Derivation',
  'Run preset',
  'Visibility',
  'Showcase',
  'Catalog',
] as const;

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const application = Object.fromEntries(
  Object.entries(sources).filter(
    ([path]) =>
      !path.startsWith('/src/api/') && !path.startsWith('/src/test/') && !isTestSupport(path)
  )
);

/**
 * The composition and problem vocabulary scope: the screens of compositions (list, detail and its tabs, the public list, the
 * showcase, Language), the problem screens (`pages/Problems`), and the layers they are built from.
 */
const SCOPE =
  /^\/src\/(pages\/(Compositions|PublicCompositions|Language|Problems)\/|modules\/core\/components\/(candidate-matrix|composition-renderer|pricing-card|problems-panel|provider-map|rules-and-objectives|value-badge|workflow-graph)\/|modules\/composition\/components\/(change-summary|evolution-charts|fork)\/|modules\/core\/utils\/(composition|binding)\/|modules\/composition-editor\/components\/composition-editor\/|modules\/run\/components\/derive\/)/;
const SCOPE_AREAS = [
  '/src/pages/Compositions/',
  '/src/pages/PublicCompositions/',
  '/src/pages/Language/',
  '/src/pages/Problems/',
  '/src/modules/core/components/composition-renderer/',
  '/src/modules/core/components/value-badge/',
  '/src/modules/composition/components/change-summary/',
  '/src/modules/core/utils/composition/',
  '/src/modules/core/utils/binding/',
  '/src/modules/composition-editor/components/composition-editor/',
  '/src/modules/run/components/derive/',
  '/src/modules/composition/components/fork/',
];

const pick = (predicate: (path: string) => boolean): Record<string, string> =>
  Object.fromEntries(Object.entries(application).filter(([path]) => predicate(path)));
const scope = pick(path => SCOPE.test(path));

/**
 * The words the scope does not show:
 * - `deployment(s)`: a composition is put into service in an Environment;
 * - `scenario(s)`: the variants of a problem are its revisions;
 * - `build(s)`: nothing is built, a version is evaluated;
 * - `project(s)`: there are organizations; and the names of the language that are not its name (`Application2Yaml`, a versioned
 *   `Composition2Yaml v1` or `v2`: the version of the language is `syntaxVersion`).
 */
const FORBIDDEN = wordPattern([
  'deployment',
  'deployments',
  'scenario',
  'scenarios',
  'build',
  'builds',
  'project',
  'projects',
  'Application2Yaml',
  'Composition2Yaml v1',
  'Composition2Yaml v2',
]);

/** "Plan" next to a proposal: a proposal is a typed change, and "plan" is kept for the plans of a pricing. */
const PLAN_WITH_PROPOSAL = /^(?=[\s\S]*\bproposals?\b)[\s\S]*\bplans?\b/i;

/**
 * Outside the scope these words name other things, and stay: rewording them would mislead (D23). Each entry is a file that shows
 * one, with what it names; the test below fails when an entry no longer does, so the list cannot go stale. The engines area,
 * engine registration, runs, studies, account, admin, authentication, pricing, About, Home and the site content are outside the
 * scope for the same reasons, as is the engine protocol row of the Home compatibility gate (`Deployment`, a single word in a `name`
 * the scanner does not read). The composition-first Home copy is reviewed in the visual QA instead.
 */
const OUTSIDE: Readonly<Record<string, string>> = {
  '/src/pages/RegisterEngine/DeploymentForm.tsx':
    'an engine deployment, registered with the platform',
  '/src/pages/Engines/EngineParts.tsx':
    'an engine deployment, and "Verified" for the outcome of its conformance probe',
  '/src/pages/Runs/RunLaunch.tsx': 'the engine deployment a federated run is sent to',
  '/src/modules/auth/components/login-form/index.tsx': 'this OpenBinding installation',
  '/src/pages/About/AboutPanels.tsx': 'the related projects of About',
  '/src/pages/Studies/StudyList.tsx': '"Build a study"',
  '/src/content/platform.ts':
    'the research topics: scenario aggregation, building comparative studies',
};

/** The words of a value status. In the scope they are printed only by `ValueBadge` (`modules/core/components/value-badge`). */
const BADGE_WORDS: ReadonlySet<string> = new Set(['Verified', 'Declared', 'Unverified']);
const VALUE_BADGE = /^\/src\/modules\/core\/components\/value-badge\//;

/** Where the kind labels are written: the only place. */
const KINDS_FILE = '/src/modules/core/utils/composition/kinds.ts';
const LABELS: ReadonlySet<string> = new Set(['Application', 'Workflow', 'Pipeline', 'System']);

/** "Workflow" alone also titles the workflow of a composition or a problem, which is not its kind. */
const WORKFLOW_TITLES: Readonly<Record<string, string>> = {
  '/src/modules/core/components/composition-renderer/modes/workflow.tsx':
    'the section of the renderer that draws the workflow',
  '/src/modules/composition-editor/components/composition-editor/VisualPane.tsx':
    'the part of the visual editor that shows the workflow',
  '/src/pages/Problems/ProblemRevision.tsx': 'the workflow of a problem version',
  '/src/pages/Problems/problemsModel.ts':
    'the row of a problem comparison that compares the workflows',
};

/** Every text written whole, as a string literal or as JSX text: `file:line  text`, in the files given. */
function wholeTexts(
  files: Readonly<Record<string, string>>,
  wanted: ReadonlySet<string>
): Finding[] {
  return Object.keys(files)
    .sort()
    .flatMap(file => {
      const tree = ts.createSourceFile(
        file,
        files[file],
        ts.ScriptTarget.ES2022,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const found: Finding[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node))
          return;
        const text =
          ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            ? node.text.trim()
            : null;
        if (text !== null && wanted.has(text)) {
          found.push({
            file,
            line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
            where: 'text',
            text,
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      return found;
    });
}

/**
 * The object literals that map the kinds to words (`{ application: 'Application', workflow: 'Workflow', … }`), in any file: two
 * kinds or more labelled. A map of BIM resource roles names `application` alone, and is not one.
 */
function kindMaps(files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files)
    .sort()
    .flatMap(file => {
      const tree = ts.createSourceFile(
        file,
        files[file],
        ts.ScriptTarget.ES2022,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const labelled = node.properties.filter(
            property =>
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
              (KINDS as readonly string[]).includes(property.name.text) &&
              ts.isStringLiteral(property.initializer) &&
              LABELS.has(property.initializer.text)
          );
          if (labelled.length >= 2)
            found.push(
              `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
      return found;
    });
}

describe('the glossary of the screens', () => {
  const glossary = readFileSync(`${process.cwd()}/../docs/GLOSSARY.md`, 'utf8');
  const defined = [...glossary.matchAll(/^\| \*\*([^*]+)\*\*/gm)].map(match => match[1]);

  it('reads the terms of docs/GLOSSARY.md', () => {
    expect(defined.length).toBeGreaterThan(10);
  });

  it.each(GLOSSARY)('defines %s in docs/GLOSSARY.md', term => {
    const word = new RegExp(`\\b${term}\\b`, 'i');
    expect(
      defined.filter(entry => word.test(entry)),
      `${term} is a term of the glossary`
    ).not.toEqual([]);
  });
});

describe('the composition and problem vocabulary scope', () => {
  it('reads every area of the scope, and only application code', () => {
    for (const area of SCOPE_AREAS)
      expect(Object.keys(scope).filter(path => path.startsWith(area)).length, area).toBeGreaterThan(
        0
      );
    expect(Object.keys(scope).length).toBeGreaterThan(80);
    expect(Object.keys(scope).some(path => isTestSupport(path))).toBe(false);
  });

  it('shows no deployment, scenario, build or project, nor another name of the language', () => {
    expect(scanFiles(scope, FORBIDDEN).map(formatFinding)).toEqual([]);
  });

  it('never says plan next to proposal', () => {
    expect(scanFiles(scope, PLAN_WITH_PROPOSAL).map(formatFinding)).toEqual([]);
  });

  it('keeps the same words out of the examples of the Language page', () => {
    const shown = examples.sections.flatMap(section => [section.name, section.description]);
    expect(shown.length).toBeGreaterThan(10);
    expect(shown.filter(text => FORBIDDEN.test(text) || PLAN_WITH_PROPOSAL.test(text))).toEqual([]);
  });

  it('prints Verified, Declared and Unverified only through ValueBadge', () => {
    expect(
      wholeTexts(
        pick(path => VALUE_BADGE.test(path)),
        BADGE_WORDS
      )
        .map(finding => finding.text)
        .sort()
    ).toEqual(['Declared', 'Unverified', 'Verified']);
    expect(
      wholeTexts(
        pick(path => SCOPE.test(path) && !VALUE_BADGE.test(path)),
        BADGE_WORDS
      ).map(formatFinding)
    ).toEqual([]);
  });

  it('lists only exemptions outside the scope that still show such a word', () => {
    const shows = (file: string) =>
      scanFiles({ [file]: application[file] }, FORBIDDEN).length > 0 ||
      wholeTexts({ [file]: application[file] }, BADGE_WORDS).length > 0;
    expect(
      Object.keys(OUTSIDE).filter(
        file => !(file in application) || SCOPE.test(file) || !shows(file)
      )
    ).toEqual([]);
  });
});

describe('the kinds of a composition', () => {
  it('are labelled exactly Application, Workflow, Pipeline and System', () => {
    expect(KINDS.map(kind => KIND_LABELS[kind])).toEqual([
      'Application',
      'Workflow',
      'Pipeline',
      'System',
    ]);
  });

  it('are labelled only in modules/core/utils/composition/kinds.ts', () => {
    expect(kindMaps(application)).toEqual([
      expect.stringMatching(/^\/src\/modules\/core\/utils\/composition\/kinds\.ts:\d+$/),
    ]);
    const written = wholeTexts(
      pick(path => SCOPE.test(path) && path !== KINDS_FILE),
      LABELS
    ).filter(finding => !(finding.text === 'Workflow' && finding.file in WORKFLOW_TITLES));
    expect(written.map(formatFinding)).toEqual([]);
  });

  it('lists only workflow titles that still exist', () => {
    const titled = new Set(
      wholeTexts(
        pick(path => path in WORKFLOW_TITLES),
        new Set(['Workflow'])
      ).map(finding => finding.file)
    );
    expect(Object.keys(WORKFLOW_TITLES).filter(file => !titled.has(file))).toEqual([]);
  });
});
