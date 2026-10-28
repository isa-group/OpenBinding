import { matchRoutes } from 'react-router-dom';
import type { MovedRoute } from './moved';

/**
 * Test support. Where an address ends once the moved addresses on its way have redirected it, so a test of a redirect can state the
 * address it expects as the code names it, and stay true when a later change moves that address on. A screen wins a tie of rank over
 * a moved entry, as in `AppRoutes`. The query and the hash of the old address go on to the new one, as `MovedRedirect` carries them.
 */
export function followMoved(
  address: string,
  screens: ReadonlyArray<{ id: string; path: string }>,
  table: readonly MovedRoute[],
): string {
  const config = [
    ...screens.map(({ id, path }) => ({ id, path })),
    ...table.map((route) => ({ id: `moved:${route.id}`, path: route.path })),
  ];
  let current = address;
  for (let hops = 0; hops < 8; hops += 1) {
    const url = new URL(current, 'http://localhost');
    const last = matchRoutes(config, url.pathname)?.at(-1);
    const entry = table.find((route) => `moved:${route.id}` === last?.route.id);
    if (!entry || !last) return current;
    const target = entry.target(url.searchParams, last.params);
    current = target.includes('#') ? target : `${target}${url.hash}`;
  }
  throw new Error(`the moved addresses lead ${address} round in a circle`);
}
