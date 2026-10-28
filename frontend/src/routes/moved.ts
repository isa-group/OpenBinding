// Addresses that moved to another one (M2.6). Data and a helper only: the redirect component lives in index.tsx.
// Unlike RETIRED_ROUTES (retiredRoutes.tsx, screens that are gone) a moved address keeps its parameters and, by default, its query.
// Keep one call per line with literal arguments, `moved('id', '/from', '/to'…`: the end-to-end smoke test reads them from the area files.

// [impl->req~frontend-nav-redirects~1]

/** What React Router hands to a matched route: decoded segments, absent when the path has none. */
export type MovedParams = Readonly<Partial<Record<string, string>>>;

export interface MovedRoute {
  id: string;
  /** The old address, a route pattern (`/app/:org/:project/files`). */
  path: string;
  /** The address to go to, query included. */
  target: (query: URLSearchParams, params: MovedParams) => string;
  /**
   * The old address stays valid on purpose (a link to it is not a defect): links.test.ts does not flag a link to it. Without it, the
   * old address is on its way out and the code must not link to it.
   */
  permanent?: boolean;
  /** `false` drops the query string of the old address. Applies to the default target only. */
  keepQuery?: boolean;
}

export interface MovedOptions {
  /** Replaces the default target, which fills the `:param` segments of `to` and carries the query. It decides about the query itself. */
  target?: MovedRoute['target'];
  permanent?: boolean;
  keepQuery?: boolean;
}

const paramsOf = (path: string): string[] => path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));

/** `to` with every `:param` segment replaced by the encoded value the matched route gave it. */
export function fillPath(to: string, params: MovedParams): string {
  return to.replace(/\/:([A-Za-z][A-Za-z0-9_]*)/g, (_whole, name: string) => `/${encodeURIComponent(params[name] ?? '')}`);
}

/**
 * A moved address: `from` and `to` are path patterns, and the `:param` segments of `to` take the values of the same-named segments of
 * `from`. The query string of the old address is carried unless `options.keepQuery` is `false`. `options.target` takes over completely.
 */
export function moved(id: string, from: string, to: string, options: MovedOptions = {}): MovedRoute {
  if (!options.target) {
    const known = new Set(paramsOf(from));
    const unknown = paramsOf(to).filter((name) => !known.has(name));
    if (unknown.length > 0) throw new Error(`moved route ${id}: ${unknown.map((name) => `:${name}`).join(', ')} of ${to} is not a parameter of ${from}`);
  }
  const keepQuery = options.keepQuery !== false;
  const route: MovedRoute = {
    id,
    path: from,
    target: options.target ?? ((query, params) => {
      const address = fillPath(to, params);
      const search = keepQuery ? query.toString() : '';
      return search ? `${address}${address.includes('?') ? '&' : '?'}${search}` : address;
    }),
  };
  if (options.permanent !== undefined) route.permanent = options.permanent;
  if (options.keepQuery !== undefined) route.keepQuery = options.keepQuery;
  return route;
}
