import { readFileSync } from 'node:fs';

// The screens of the QA gallery: every `{ id: 'id', path: '/path', layout: '…', … },` line of `screens` in src/routes/router.tsx
// (the table itself pulls in the whole application, so the file is read as text, as routes-smoke.spec.ts does), each with an
// example address whose parameters name things the shared mock answers for.

/** One line of the route table, read as text. */
export interface ScreenLine {
  id: string;
  path: string;
  layout: 'public' | 'session' | 'app';
  requireAdmin: boolean;
}

const SCREEN_LINE =
  /^\s*\{ id: '([a-z0-9-]+)', path: '(\/[^']*)', layout: '(public|session|app)'(.*)$/gm;

function routerSource(): string {
  return readFileSync(new URL('../../src/routes/router.tsx', import.meta.url), 'utf8');
}

/** The screens of src/routes/router.tsx, in table order. */
export function readScreenLines(): ScreenLine[] {
  return [...routerSource().matchAll(SCREEN_LINE)].map(match => ({
    id: match[1],
    path: match[2],
    layout: match[3] as ScreenLine['layout'],
    requireAdmin: match[4].includes('requireAdmin: true'),
  }));
}

/** Every line of the table that opens a screen: the screens that `readScreenLines` has to find. */
export function countScreenLines(): number {
  return routerSource().match(/^\s*\{ id: /gm)?.length ?? 0;
}

/**
 * The route pattern without its optional segments (`:section?`), each dropped with its slash, so an example address visits the base
 * address of a screen that takes sections (`/app/account/:section?` is visited at `/app/account`). Fill the other parameters afterwards.
 * A `?` that starts a query (`/app/:org?create=organization`) is not an optional marker: the marker ends the segment.
 */
export function dropOptionalSegments(path: string): string {
  return path.replace(/\/:[A-Za-z][A-Za-z0-9]*\?(?=\/|$)/g, '') || '/';
}

export interface GalleryScreen {
  id: string;
  /** The route pattern, exactly as the table lists it. */
  path: string;
  layout: ScreenLine['layout'];
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
  composition: 'fleet-routing',
  case: 'checkout-flow',
  revision: '2',
  artifact: 'providers-eu',
  draft: 'draft-providers-4',
  version: '3',
  resource: 'latency-probes',
  study: 'engines-vs-seeds',
  run: '00000000-0000-4000-8000-000000000101',
  cell: '00000000-0000-4000-8000-000000000202',
  job: '00000000-0000-4000-8000-0000000000a1',
  digest: `sha256-${'e'.repeat(64)}`,
  namespace: 'bim.builtin',
  name: 'random-search',
  user: '00000000-0000-4000-8000-000000000002',
} as const;

/** Parameters whose example value differs from the generic one on one screen. */
const PARAMS_OF: Record<string, Record<string, string>> = {
  'eng-detail': { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0' },
  'eng-registration-detail': { name: 'edge-solver' },
  // The public page of the shared mock's public composition of another organization (e2e/helpers/mockCompositions.ts).
  'pub-showcase': { org: 'lab-other', composition: 'fleet-routing' },
};

/** The query string that makes a screen show something instead of its starting point. */
const QUERY_OF: Record<string, string> = {
  'eng-registration-detail': `?namespace=alex.rivera&version=0.3.1&digest=sha256-${'e5f6'.repeat(16)}`,
  'run-launch': '?problem=checkout-flow&revision=2',
  'study-builder': '?case=checkout-flow&revision=2',
  'problem-editor': '?problem=checkout-flow&revision=2',
};

export function readGalleryScreens(): GalleryScreen[] {
  return readScreenLines().map(({ id, path, layout, requireAdmin }) => {
    const params: Record<string, string> = { ...EXAMPLE, ...PARAMS_OF[id] };
    const address = dropOptionalSegments(path).replace(
      /:([A-Za-z]+)/g,
      (_whole, name: string) => params[name] ?? 'sample'
    );
    return {
      id,
      path,
      layout,
      requireAdmin,
      underApp: path === '/app' || path.startsWith('/app/'),
      sessionHeader: layout === 'session',
      url: `${address}${QUERY_OF[id] ?? ''}`,
    };
  });
}
