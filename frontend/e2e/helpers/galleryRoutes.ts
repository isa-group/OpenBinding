import { readFileSync } from 'node:fs';

// The screens of the QA gallery: every `live('id', '/path', …)` / `pending('id', '/path', …)` line of src/routes/d1.tsx .. d8.tsx
// (the registry itself pulls in the whole application, so the files are read as text, as routes-smoke.spec.ts does), each with an
// example address whose parameters name things the shared mock answers for.

const DOMAIN_FILES = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];

export interface GalleryScreen {
  id: string;
  /** The route pattern, exactly as the registry lists it. */
  path: string;
  domain: string;
  status: 'live' | 'pending';
  requireAdmin: boolean;
  /** The screen sits under /app (the authenticated workspace). */
  underApp: boolean;
  /** A public address that signed-in people use too (it renders in the application layout with a session). */
  sessionHeader: boolean;
  /** The address the gallery visits: parameters replaced, plus the query some screens need to show their content. */
  url: string;
}

export const EXAMPLE = {
  org: 'isa-demo',
  project: 'qos-benchmarks',
  case: 'checkout-flow',
  revision: '2',
  snapshot: '00000000-0000-4000-8000-0000000000e1',
  artifact: 'providers-eu',
  draft: 'draft-providers-4',
  version: '3',
  resource: 'latency-probes',
  collection: 'checkout-references',
  study: 'engines-vs-seeds',
  run: '00000000-0000-4000-8000-000000000101',
  cell: '00000000-0000-4000-8000-000000000202',
  job: '00000000-0000-4000-8000-0000000000a1',
  report: 'engine-comparison',
  kind: 'report',
  digest: `sha256-${'e'.repeat(64)}`,
  namespace: 'bim.builtin',
  name: 'random-search',
  user: '00000000-0000-4000-8000-000000000002',
} as const;

/** Parameters whose example value differs from the generic one on one screen. */
const PARAMS_OF: Record<string, Record<string, string>> = {
  'lang-schemas': { kind: 'Instance' },
  'eng-detail': { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0' },
  'admin-pricing-release': { version: '0.1.0' },
  'admin-sponsor': { org: 'isa-demo' },
  'eng-registration-detail': { name: 'edge-solver' },
};

/** The query string that makes a screen show something instead of its starting point. */
const QUERY_OF: Record<string, string> = {
  'eng-registration-detail': `?namespace=alex.rivera&version=0.3.1&digest=sha256-${'e5f6'.repeat(16)}`,
  'analysis-workspace': '?job=f1a1b2c3-0000-4000-8000-000000000001&job=f2a1b2c3-0000-4000-8000-000000000002',
  'job-launch': '?case=checkout-flow&revision=2',
  'study-builder': '?case=checkout-flow&revision=2',
  'wb-workbench': '?case=checkout-flow&revision=2',
  'case-compare': '?from=1&to=2',
  verifier: `?digest=sha256-${'e'.repeat(64)}`,
  // The link of the reset e-mail carries its one-time token; the screen shows the form it opens.
  'auth-reset-complete': '?token=gallery-reset-token',
};

export function readGalleryScreens(): GalleryScreen[] {
  return DOMAIN_FILES.flatMap((domain) => {
    const source = readFileSync(new URL(`../../src/routes/${domain}.tsx`, import.meta.url), 'utf8');
    return [...source.matchAll(/^\s*(live|pending)\('([a-z0-9-]+)',\s*'(\/[^']*)'(.*)$/gm)].map((match) => {
      const [, status, id, path, rest] = match;
      const params: Record<string, string> = { ...EXAMPLE, ...PARAMS_OF[id] };
      const address = path.replace(/:([A-Za-z]+)/g, (_whole, name: string) => params[name] ?? 'sample');
      return {
        id,
        path,
        domain: domain.toUpperCase(),
        status: status as GalleryScreen['status'],
        requireAdmin: rest.includes('requireAdmin: true'),
        underApp: path === '/app' || path.startsWith('/app/'),
        sessionHeader: rest.includes('sessionHeader: true'),
        url: `${address}${QUERY_OF[id] ?? ''}`,
      };
    });
  });
}
