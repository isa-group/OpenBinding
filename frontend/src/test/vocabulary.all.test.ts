import { describe, expect, it } from 'vitest';
import { formatFinding, isTestSupport, scanFiles, wordPattern, type Finding } from './vocabulary';

// Every application source file shows none of the words `case`, `cases`, `job`, `jobs`, `publication`, `publications` as visible text
// (`req~frontend-nav-vocabulary-text~1`), except the exemptions listed below. The scanner reads the text a source file puts on screen; text
// composed at run time is the route smoke's job.

const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// Not scanned: the HTTP client layer (`src/api/`, which names API fields and paths), the test kit, and test files (the scanner skips those).
const scanned = Object.fromEntries(Object.entries(sources).filter(([path]) => (
  !path.startsWith('/src/api/') && !path.startsWith('/src/test/') && !isTestSupport(path)
)));

const ALL_WORDS = wordPattern(['case', 'cases', 'job', 'jobs', 'publication', 'publications']);
const WORDS_WITHOUT_PUBLICATION = wordPattern(['case', 'cases', 'job', 'jobs']);

// The three engine-registration screens (`eng-register`, `eng-registrations`, `eng-registration-detail`) keep the engine publication text:
// they are scanned for the other four words only.
const ENGINE_REGISTRATION = /^\/src\/pages\/(RegisterEngine\/|Engines\/(EngRegistrations|EngRegistrationDetail|registrationModel)\.)/;

// Files that still show a forbidden word and that a later task owns; none is left. An entry is a path with the reason.
// The test below fails when an entry no longer matches, so the list cannot go stale.
const EXEMPT: Readonly<Record<string, string>> = {};

const scan = (files: Record<string, string>, words: RegExp): Finding[] => scanFiles(files, words);

const pick = (predicate: (path: string) => boolean): Record<string, string> => (
  Object.fromEntries(Object.entries(scanned).filter(([path]) => predicate(path)))
);

const findings = (): Finding[] => [
  ...scan(pick((path) => !ENGINE_REGISTRATION.test(path)), ALL_WORDS),
  ...scan(pick((path) => ENGINE_REGISTRATION.test(path)), WORDS_WITHOUT_PUBLICATION),
];

describe('the vocabulary of every source file', () => {
  // [utest->req~frontend-nav-vocabulary-text~1]
  it('reads the application sources, the engine-registration screens among them', () => {
    const paths = Object.keys(scanned);
    expect(paths.length).toBeGreaterThan(200);
    expect(paths.filter((path) => path.startsWith('/src/pages/')).length).toBeGreaterThan(100);
    expect(paths.filter((path) => ENGINE_REGISTRATION.test(path)).length).toBeGreaterThanOrEqual(4);
    expect(paths.some((path) => path.startsWith('/src/api/') || path.startsWith('/src/test/') || /\.test\./.test(path))).toBe(false);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('shows no case, job or publication text outside the listed exemptions', () => {
    const reported = findings().filter((finding) => !(finding.file in EXEMPT));
    expect(reported.map(formatFinding)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('keeps the engine publication text only on the three engine-registration screens', () => {
    const registration = pick((path) => ENGINE_REGISTRATION.test(path));
    expect(scan(registration, wordPattern(['publication', 'publications'])).length).toBeGreaterThan(0);
    expect(scan(registration, WORDS_WITHOUT_PUBLICATION).map(formatFinding)).toEqual([]);
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('keeps the message strings of the HTTP client free of the word job', () => {
    const client = sources['/src/api/client.ts'];
    expect(client).toBeDefined();
    expect(client).not.toContain('Job failed');
    expect(client).not.toContain('The job could not be found');
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('lists only exemptions that still show a forbidden word', () => {
    const stale = Object.keys(EXEMPT).filter((file) => !(file in scanned) || scan({ [file]: scanned[file] }, ALL_WORDS).length === 0);
    expect(stale).toEqual([]);
  });
});
