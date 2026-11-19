import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { screens } from './router';

// The screens of the application, exactly: one row per screen of `screens` (routes/router.tsx), with its address and layout.
// The convergence on SPHERE ended at 38 screens (design §9). F5: −/sso/callback, +/sso/identity/callback,
// +/sso/identity/username (39: 21 public, 18 protected); F7 adds /orbit (40), F9 five collection routes (45). A block that adds or removes a screen changes this list and the ceiling in the same commit.

// prettier-ignore
const SCREENS: Array<[string, string, string]> = [
  ['auth', '/authentication', 'public'],
  ['auth-forgot-password', '/forgot-password', 'public'],
  ['auth-reset-password', '/reset-password', 'public'],
  ['auth-identity-callback', '/sso/identity/callback', 'public'],
  ['pub-home', '/', 'session'],
  ['org-explore', '/organizations', 'session'],
  ['org-detail', '/orgs/:org/:tab?', 'session'],
  ['pub-compositions', '/compositions', 'session'],
  ['composition-card', '/compositions/:org/:composition/:tab?', 'session'],
  ['composition-permalink', '/p/:id', 'session'],
  ['eng-catalog', '/engines', 'session'],
  ['eng-detail', '/engines/:namespace/:name/:version', 'session'],
  ['pub-language', '/language', 'session'],
  ['pub-pricing', '/pricing', 'session'],
  ['pub-team', '/team', 'session'],
  ['pub-research', '/research', 'session'],
  ['pub-contributions', '/contributions', 'session'],
  ['pub-changelog', '/changelog', 'session'],
  ['org-list', '/me/orgs', 'protected'],
  ['org-new', '/orgs/new', 'protected'],
  ['org-join', '/orgs/join/:code', 'protected'],
  ['my-compositions', '/me/compositions', 'protected'],
  ['composition-new', '/compositions/new', 'protected'],
  ['notifications', '/notifications', 'protected'],
  ['acct-settings', '/me/settings', 'protected'],
  ['acct-api-keys', '/me/api-keys', 'protected'],
  ['problem-detail', '/problems/:org/:problem/:tab?', 'protected'],
  ['run-launch', '/runs/new', 'protected'],
  ['run-detail', '/runs/:org/:run', 'protected'],
  ['study-builder', '/studies/new', 'protected'],
  ['study-detail', '/studies/:org/:study/:tab?', 'protected'],
  ['eng-registrations', '/me/engines', 'protected'],
  ['eng-register', '/me/engines/new', 'protected'],
  ['eng-registration-detail', '/me/engines/:name', 'protected'],
  ['admin', '/admin/:section?', 'protected'],
  ['admin-user-detail', '/admin/users/:user', 'protected'],
  ['composition-editor', '/editor', 'standalone'],
  ['problem-editor', '/problem-editor', 'standalone'],
];

const CEILING = 38;

describe('screen budget', () => {
  it('serves exactly the listed screens, with their addresses and layouts, in table order', () => {
    expect(screens.map(screen => [screen.id, screen.path, screen.layout])).toEqual(SCREENS);
  });

  it(`has at most ${CEILING} screens`, () => {
    expect(
      screens.length,
      `${screens.length} screens against a ceiling of ${CEILING}`
    ).toBeLessThanOrEqual(CEILING);
    expect(screens).toHaveLength(CEILING);
  });

  it('opens 20 screens to visitors (the public, session and editor layouts) and keeps 18 behind an account', () => {
    expect(screens.filter(screen => screen.layout !== 'protected')).toHaveLength(20);
    expect(screens.filter(screen => screen.layout === 'protected')).toHaveLength(18);
  });

  it('keeps one screen per line in router.tsx, which the end-to-end parsers read', () => {
    const source = readFileSync(`${process.cwd()}/src/routes/router.tsx`, 'utf8');
    const lines =
      source.match(
        /^\s*\{ id: '[a-z0-9-]+', path: '\/[^']*', layout: '(public|session|protected|app|standalone)'.*\},$/gm
      ) ?? [];
    expect(lines).toHaveLength(screens.length);
  });

  it('keeps no area registry and no per-domain route file under routes/', () => {
    const files = import.meta.glob('./**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const paths = Object.keys(files);
    expect(paths.filter(path => /^\.\/(areas\/|registry|define|d[1-8]\.tsx)/.test(path))).toEqual(
      []
    );
    expect(
      paths.filter(
        path =>
          !path.endsWith('screenBudget.test.ts') && /routesByArea|routesByDomain/.test(files[path])
      )
    ).toEqual([]);
  });
});
