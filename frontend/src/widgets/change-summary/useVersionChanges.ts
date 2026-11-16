// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-version-graph/use-version-changes.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the two versions are compared by the gateway (`compositionsApi.diff`) instead of reading and diffing both YAML
// files in the browser, so the cache keeps diffs by version pair where SPHERE kept files by URL; the credential is the signed-in
// account (`useAuth`); a version with nothing before it is not a target (the gateway has nothing to compare it with); and the
// cached answer is read during render instead of being set from the effect.

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/auth';
import { compositionsApi } from '../../entities/composition/api';
import { versionChanges, type VersionChanges } from '../../entities/composition/changes';
import type { CompositionVersionDiff } from '../../shared/api/types';

/** Two versions of a composition to compare, by id; `key` names the row or point that asks. */
export interface ChangesTarget {
  org: string;
  composition: string;
  key: string;
  before: string;
  after: string;
}

export type ChangesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; summary: VersionChanges }
  | { status: 'error' };

/** A pointer that only passes over a row loads nothing. */
const HOVER_DELAY_MS = 150;

/**
 * What a version changed from another, as the gateway's diff of the two reads. Diffs and summaries are kept, so asking for a
 * pair again answers at once; a refresh (`revision`) or another credential starts a new cache.
 */
export function useVersionChanges(
  target: ChangesTarget | null,
  revision: object | null
): ChangesState {
  const { user } = useAuth();
  const credential = user?.id ?? null;
  // A refresh or a credential change starts a new cache. Old requests may finish, but can neither populate the new cache nor
  // display their old result.
  const cache = useMemo(
    () => ({
      credential,
      revision,
      diffs: new Map<string, Promise<CompositionVersionDiff>>(),
      summaries: new Map<string, VersionChanges>(),
    }),
    [credential, revision]
  );
  const key = target
    ? JSON.stringify([target.org, target.composition, target.key, target.before, target.after])
    : null;
  const [state, setState] = useState<{
    cache: typeof cache;
    key: string;
    value: ChangesState;
  } | null>(null);

  useEffect(() => {
    if (!target || key === null || cache.summaries.has(key)) return;

    const read = (org: string, composition: string, before: string, after: string) => {
      const pair = JSON.stringify([org, composition, before, after]);
      let diff = cache.diffs.get(pair);
      if (!diff) {
        diff = compositionsApi.diff(org, composition, before, after);
        // A failed comparison is tried again the next time.
        diff.catch(() => cache.diffs.delete(pair));
        cache.diffs.set(pair, diff);
      }
      return diff;
    };

    let active = true;
    const timer = setTimeout(() => {
      setState({ cache, key, value: { status: 'loading' } });
      read(target.org, target.composition, target.before, target.after)
        .then(diff => {
          const summary = versionChanges(diff);
          cache.summaries.set(key, summary);
          if (active) setState({ cache, key, value: { status: 'ready', summary } });
        })
        .catch(() => {
          if (active) setState({ cache, key, value: { status: 'error' } });
        });
    }, HOVER_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, cache]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target || key === null) return { status: 'idle' };
  const cached = cache.summaries.get(key);
  if (cached) return { status: 'ready', summary: cached };
  return state?.cache === cache && state.key === key ? state.value : { status: 'loading' };
}
