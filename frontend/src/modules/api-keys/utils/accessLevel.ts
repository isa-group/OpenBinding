// Adapted from the `SCOPE_OPTIONS` of SPHERE frontend/src/modules/core/components/scope-selector.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's three access levels (View only, Management, All) read as the HTTP methods of OpenBinding's key boundary.

import type { ApiKeyBoundary } from '../api/apiKeysApi';

export type AccessLevel = 'VIEW' | 'MANAGEMENT' | 'ALL';
type Method = NonNullable<ApiKeyBoundary['methods']>[number];

export const ACCESS_LEVELS: ReadonlyArray<{
  value: AccessLevel;
  label: string;
  description: string;
  methods: Method[] | null;
}> = [
  {
    value: 'VIEW',
    label: 'View only',
    description: 'Read access only (GET)',
    methods: ['GET'],
  },
  {
    value: 'MANAGEMENT',
    label: 'Management',
    description: 'Read, create and change, but never delete (GET, POST, PUT, PATCH)',
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
  },
  {
    value: 'ALL',
    label: 'All',
    description: 'Every method its permissions allow, deletion included',
    methods: null,
  },
];

/** The methods a level limits the key to; `null` for no limit. */
export function methodsOf(level: AccessLevel): Method[] | null {
  return ACCESS_LEVELS.find(item => item.value === level)?.methods ?? null;
}
