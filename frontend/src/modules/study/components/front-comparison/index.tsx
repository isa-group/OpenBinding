// Pattern only, after SPHERE frontend/src/modules/pricing/components/configuration-space-view/configuration-comparison.tsx
// (feat/pricing-renderer, revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García
// Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md. The two points the compare tray holds are compared
// through the compositions derived from them, with the composition module's structured diff (SPHERE's pricing-version-diff)
// and its line-by-line file diff.

import { useCallback, useEffect, useState } from 'react';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { readApiError } from '../../../core/api/errors';
import type { CompositionVersionDiff } from '../../../core/api/types';
import type { ChangeKind } from '../../../core/components/composition-renderer/modes/graph-diff/diffModel';
import { compositionsApi, languageApi } from '../../../composition/api/compositionsApi';
import { DiffResult } from '../../../composition/components/version-diff';
import FileDiffView from '../../../composition/components/version-diff/file-diff-view';
import type { DerivedPoint } from '../../../run/components/derive/DeriveBatch';

/** One side of the comparison: a point of the front and the composition derived from it. */
export interface ComparedPoint {
  label: string;
  derived: DerivedPoint;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; diff: CompositionVersionDiff; before: string; after: string };

const sideName = (side: ComparedPoint) =>
  `${side.label} · ${side.derived.slug} ${side.derived.version.label}`;

/**
 * Two points of a study front side by side, through the compositions derived from them: both stored texts are read, the gateway's
 * document diff (`POST /v1/compositions/diff`) says what changed, and the structured diff of the Versions tab shows it, with the two
 * texts line by line on request. The two documents are versions of different compositions, so the diff is named after the points.
 */
export function FrontComparison({
  org,
  before,
  after,
}: {
  org: string;
  before: ComparedPoint;
  after: ComparedPoint;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [texts, setTexts] = useState(false);
  const [filter, setFilter] = useState<ChangeKind | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [first, second] = await Promise.all([
          compositionsApi.content(org, before.derived.slug, before.derived.version.id),
          compositionsApi.content(org, after.derived.slug, after.derived.version.id),
        ]);
        const result = await languageApi.diffDocuments(first, second);
        const diff: CompositionVersionDiff = {
          ...result,
          from: { id: before.derived.version.id, label: sideName(before) },
          to: { id: after.derived.version.id, label: sideName(after) },
        };
        if (active) setLoaded({ status: 'ready', diff, before: first, after: second });
      } catch (caught) {
        const error = readApiError(caught);
        const code = error.status
          ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})`
          : '';
        if (active)
          setLoaded({
            status: 'error',
            message: `The two compositions couldn’t be compared${code}.`,
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [org, before, after, attempt]);

  const retry = useCallback(() => {
    setLoaded({ status: 'loading' });
    setAttempt(value => value + 1);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-tp-steel">{`${sideName(before)} compared with ${sideName(after)}: what the gateway finds changed between their documents.`}</p>
      {loaded.status === 'loading' && (
        <p className="text-xs text-tp-steel" role="status">
          Reading both compositions…
        </p>
      )}
      {loaded.status === 'error' && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={retry}>
              Retry
            </Action>
          }
        >
          {loaded.message}
        </Notice>
      )}
      {loaded.status === 'ready' && (
        <>
          <DiffResult
            diff={loaded.diff}
            filter={filter}
            onFilterChange={setFilter}
            workflow={null}
          />
          <div>
            <Action
              variant="secondary"
              size="sm"
              aria-expanded={texts}
              onClick={() => setTexts(value => !value)}
            >
              {texts ? 'Hide the two texts' : 'Show the two texts line by line'}
            </Action>
          </div>
          {texts && (
            <FileDiffView
              before={loaded.before}
              after={loaded.after}
              beforeLabel={sideName(before)}
              afterLabel={sideName(after)}
            />
          )}
        </>
      )}
    </div>
  );
}
