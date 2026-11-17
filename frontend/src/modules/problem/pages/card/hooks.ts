// The state of the problem card page, split out of the page as the composition card page splits its own: the problem with
// its revision (`ETag`) and its revisions, read again on demand; missing and unreadable are one answer.

import { useCallback, useEffect, useState } from 'react';
import { readApiError } from '../../../core/api/errors';
import { useProblemsApi } from '../../api/problemsApi';
import type { ProblemContent } from '../../types';
import { newestFirst } from '../../utils/problemsModel';

export interface LoadedProblem extends ProblemContent {
  /** The revision every change names (`If-Match`). */
  etag: string | null;
}

export type ProblemState =
  | { status: 'loading'; loaded?: LoadedProblem }
  | { status: 'ready'; loaded: LoadedProblem }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** The problem `org/slug` with its revisions; `reload` reads both again and keeps the previous ones on show meanwhile. */
export function useCardProblem(org: string, slug: string) {
  const { getProblem, getRevisions } = useProblemsApi();
  const [state, setState] = useState<ProblemState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      getProblem(org, slug, controller.signal),
      getRevisions(org, slug, controller.signal),
    ])
      .then(([read, revisions]) => {
        if (!controller.signal.aborted)
          setState({
            status: 'ready',
            loaded: { item: read.value, etag: read.etag, revisions: newestFirst(revisions) },
          });
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        const error = readApiError(caught);
        setState(
          error.status === 404 || error.status === 403
            ? { status: 'missing' }
            : { status: 'error', message: error.message }
        );
      });
    return () => controller.abort();
  }, [getProblem, getRevisions, org, slug, attempt]);

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
