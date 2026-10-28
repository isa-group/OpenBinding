import { readdirSync, readFileSync } from 'node:fs';

// The screens of the QA gallery: every `live('id', '/path', …)` line of the files of src/routes/areas
// (the registry itself pulls in the whole application, so the files are read as text, as routes-smoke.spec.ts does), each with an
// example address whose parameters name things the shared mock answers for.

/** The registry order of the areas; an area file that is not listed comes after them, by name. */
const AREA_ORDER = [
  'public', 'auth', 'verify', 'system', 'language', 'engines', 'account', 'organizations', 'project', 'problems', 'collections', 'runs',
  'studies', 'admin',
];

const areaRank = (area: string) => {
  const rank = AREA_ORDER.indexOf(area);
  return rank === -1 ? AREA_ORDER.length : rank;
};

/** The text of every file of src/routes/areas (not the tests), in registry order, with the area it declares. */
export function readAreaSources(): Array<{ area: string; source: string }> {
  const directory = new URL('../../src/routes/areas/', import.meta.url);
  return readdirSync(directory)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => file.replace(/\.tsx$/, ''))
    .sort((a, b) => areaRank(a) - areaRank(b) || a.localeCompare(b))
    .map((area) => ({ area, source: readFileSync(new URL(`${area}.tsx`, directory), 'utf8') }));
}

/**
 * The route pattern without its optional segments (`:section?`), each dropped with its slash, so an example address visits the base
 * address of a screen that takes sections (`/language/:section?/:item?` is visited at `/language`). Fill the other parameters afterwards.
 * A `?` that starts a query (`/app/:org?create=project`) is not an optional marker: the marker ends the segment.
 */
export function dropOptionalSegments(path: string): string {
  return path.replace(/\/:[A-Za-z][A-Za-z0-9]*\?(?=\/|$)/g, '') || '/';
}

/** Every `live(` call the area files make: the screens that `readGalleryScreens` has to find. */
export function countLiveCalls(): number {
  return readAreaSources().reduce((total, { source }) => total + (source.match(/^\s*live\(/gm)?.length ?? 0), 0);
}

export interface MovedAddress {
  id: string;
  area: string;
  /** The old address, a route pattern. */
  from: string;
  /** The address it leads to, a path pattern with the parameters of `from`. */
  to: string;
  /** The entry computes its target with `options.target`: `to` is not what the browser ends on. */
  customTarget: boolean;
}

/** Every `moved('id', '/from', '/to'…` line of the area files (one call per line, literal arguments). */
export function readMovedAddresses(): MovedAddress[] {
  return readAreaSources().flatMap(({ area, source }) => [...source.matchAll(/^\s*moved\('([a-z0-9-]+)',\s*'(\/[^']*)',\s*'(\/[^']*)'(.*)$/gm)]
    .map((match) => ({ id: match[1], area, from: match[2], to: match[3], customTarget: match[4].includes('target:') })));
}

export interface GalleryScreen {
  id: string;
  /** The route pattern, exactly as the registry lists it. */
  path: string;
  area: string;
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
  'eng-detail': { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0' },
  'eng-registration-detail': { name: 'edge-solver' },
};

/** The query string that makes a screen show something instead of its starting point. */
const QUERY_OF: Record<string, string> = {
  'eng-registration-detail': `?namespace=alex.rivera&version=0.3.1&digest=sha256-${'e5f6'.repeat(16)}`,
  'job-launch': '?case=checkout-flow&revision=2',
  'study-builder': '?case=checkout-flow&revision=2',
  'wb-workbench': '?case=checkout-flow&revision=2',
  'case-compare': '?from=1&to=2',
  verifier: `?digest=sha256-${'e'.repeat(64)}`,
  // The link of the reset e-mail carries its one-time token; the screen shows the form it opens.
  'auth-reset-complete': '?token=gallery-reset-token',
};

export function readGalleryScreens(): GalleryScreen[] {
  return readAreaSources().flatMap(({ area, source }) => {
    return [...source.matchAll(/^\s*live\('([a-z0-9-]+)',\s*'(\/[^']*)'(.*)$/gm)].map((match) => {
      const [, id, path, rest] = match;
      const params: Record<string, string> = { ...EXAMPLE, ...PARAMS_OF[id] };
      const address = dropOptionalSegments(path).replace(/:([A-Za-z]+)/g, (_whole, name: string) => params[name] ?? 'sample');
      return {
        id,
        path,
        area,
        requireAdmin: rest.includes('requireAdmin: true'),
        underApp: path === '/app' || path.startsWith('/app/'),
        sessionHeader: rest.includes('sessionHeader: true'),
        url: `${address}${QUERY_OF[id] ?? ''}`,
      };
    });
  });
}
