import { LanguageHub } from '../../pages/Profiles/LanguageHub';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: language. The problem language: the hub (profiles, schemas, extensions). The examples are a section of Explore.
// [impl->req~frontend-nav-language-hub~1]
// [impl->req~frontend-nav-examples-in-explore~1]

export const routes: RouteDefinition[] = [
  live('lang-profiles', '/language/:section?/:item?', <LanguageHub />),
];

const movedAddresses: MovedRoute[] = [
  moved('lang-extensions', '/app/language/extensions', '/language/extensions'),
  moved('lang-examples', '/examples', '/explore/examples'),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
