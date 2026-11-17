// The state of the composition card page, split out of the page as SPHERE's organization page splits its own: the
// composition with its revision (`ETag`) and its versions, read again on demand; missing and unreadable are one answer.

import { useCallback, useEffect, useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import { compositionsApi } from '../../api/compositionsApi';

export interface LoadedComposition {
  composition: CompositionView;
  /** The revision every change names (`If-Match`). */
  etag: string | null;
  /** Light rows, newest first. */
  versions: CompositionVersionView[];
}

export type CompositionState =
  | { status: 'loading'; loaded?: LoadedComposition }
  | { status: 'ready'; loaded: LoadedComposition }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** The composition `org/slug` with its versions; `reload` reads both again and keeps the previous ones on show meanwhile. */
export function useCardComposition(org: string, slug: string) {
  const [state, setState] = useState<CompositionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      compositionsApi.get(org, slug),
      compositionsApi.allVersions(org, slug, { order: 'newest' }),
    ])
      .then(([read, versions]) => {
        if (active)
          setState({
            status: 'ready',
            loaded: { composition: read.value, etag: read.etag, versions },
          });
      })
      .catch(caught => {
        if (!active) return;
        const error = readApiError(caught);
        setState(
          error.status === 404 || error.status === 403
            ? { status: 'missing' }
            : { status: 'error', message: error.message }
        );
      });
    return () => {
      active = false;
    };
  }, [org, slug, attempt]);

  const reload = useCallback(() => {
    setState(current =>
      current.status === 'ready'
        ? { status: 'loading', loaded: current.loaded }
        : { status: 'loading' }
    );
    setAttempt(value => value + 1);
  }, []);

  return { state, reload };
}
