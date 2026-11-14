import { LanguageHub } from '../../pages/Profiles/LanguageHub';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: language. The problem language: the hub (profiles, schemas, extensions).

export const routes: RouteDefinition[] = [
  live('lang-profiles', '/language/:section?/:item?', <LanguageHub />),
];

const movedAddresses: MovedRoute[] = [
  moved('lang-extensions', '/app/language/extensions', '/language/extensions'),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
