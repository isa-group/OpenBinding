import { Examples } from '../../pages/Examples/Examples';
import { LanguageHub } from '../../pages/Profiles/LanguageHub';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: language. The problem language: the hub (profiles, schemas, extensions) and the examples.
// [impl->req~frontend-nav-language-hub~1]

export const routes: RouteDefinition[] = [
  live('lang-profiles', '/language/:section?/:item?', <LanguageHub />),
  live('lang-examples', '/examples', <Examples />),
];

const movedAddresses: MovedRoute[] = [
  moved('lang-extensions', '/app/language/extensions', '/language/extensions'),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
