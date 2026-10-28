import { lazy } from 'react';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: verify. Opening a permanent link, looking a digest up, and checking a document or a file: one public screen.
// [impl->req~frontend-nav-verify-page~1]

const Verify = lazy(() => import('../../pages/Verify/Verify').then((module) => ({ default: module.Verify })));

export const routes: RouteDefinition[] = [
  live('verify', '/verify/:kind?/:digest?', <Verify />),
];

// Both addresses are permanent: publications cite `/resolve/<kind>/<digest>` and the gateway's `citation.url` is that address, or
// `/app/verifier?digest=<digest>` for an element without a resolvable kind. The query and the hash go on to the Verify page.
// [impl->req~frontend-nav-verify-permanent-links~1]
const movedAddresses: MovedRoute[] = [
  moved('verify-resolve', '/resolve/:kind/:digest', '/verify/:kind/:digest', { permanent: true }),
  moved('verify-verifier', '/app/verifier', '/verify', { permanent: true }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
