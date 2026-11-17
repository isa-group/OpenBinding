import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { screens } from './router';

// The screens of the application, exactly: one row per screen of `screens` (routes/router.tsx), with its address and layout.
// A block that adds or removes a screen changes this list and the ceiling in the same commit. The convergence on SPHERE ends at
// 38 screens (D9); while the domains are poured in, old and new addresses coexist and each block pins its own count.

// prettier-ignore
const SCREENS: Array<[string, string, string]> = [
  ['pub-workbench', '/workbench', 'public'],
  ['pub-about', '/about', 'public'],
  ['pub-pricing', '/pricing', 'public'],
  ['pub-language', '/language', 'public'],
  ['auth', '/authentication', 'public'],
  ['auth-forgot-password', '/forgot-password', 'public'],
  ['auth-reset-password', '/reset-password', 'public'],
  ['auth-sso-callback', '/sso/callback', 'public'],
  ['eng-catalog', '/engines', 'public'],
  ['eng-detail', '/engines/:namespace/:name/:version', 'public'],
  ['pub-home', '/', 'session'],
  ['org-explore', '/organizations', 'session'],
  ['org-detail', '/orgs/:org/:tab?', 'session'],
  ['pub-compositions', '/compositions', 'session'],
  ['pub-showcase', '/c/:org/:composition', 'session'],
  ['org-list', '/me/orgs', 'protected'],
  ['org-new', '/orgs/new', 'protected'],
  ['org-join', '/orgs/join/:code', 'protected'],
  ['my-compositions', '/me/compositions', 'protected'],
  ['notifications', '/notifications', 'protected'],
  ['acct-settings', '/me/settings', 'protected'],
  ['acct-api-keys', '/me/api-keys', 'protected'],
  ['eng-register', '/app/engines/new', 'app'],
  ['eng-registrations', '/app/engines/registrations', 'app'],
  ['eng-registration-detail', '/app/engines/registrations/:name', 'app'],
  ['composition-detail', '/app/:org/compositions/:composition/:tab?', 'app'],
  ['problem-list', '/app/:org/problems', 'app'],
  ['problem-detail', '/app/:org/problems/:case/:tab?', 'app'],
  ['problem-editor', '/app/:org/problem-editor', 'app'],
  ['run-launch', '/app/:org/runs/new', 'app'],
  ['run-list', '/app/:org/runs', 'app'],
  ['run-detail', '/app/:org/runs/:job', 'app'],
  ['study-list', '/app/:org/studies', 'app'],
  ['study-builder', '/app/:org/studies/new', 'app'],
  ['study-detail', '/app/:org/studies/:study/:tab?', 'app'],
  ['admin-overview', '/app/admin', 'app'],
  ['admin-users', '/app/admin/users', 'app'],
  ['admin-user-detail', '/app/admin/users/:user', 'app'],
  ['admin-moderation', '/app/admin/moderation', 'app'],
];

const CEILING = 39;

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

  it('keeps one screen per line in router.tsx, which the end-to-end parsers read', () => {
    const source = readFileSync(`${process.cwd()}/src/routes/router.tsx`, 'utf8');
    const lines =
      source.match(
        /^\s*\{ id: '[a-z0-9-]+', path: '\/[^']*', layout: '(public|session|protected|app)'.*\},$/gm
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
