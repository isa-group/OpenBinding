import { useCallback, useEffect, useState } from 'react';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { compositionsApi, languageApi } from '../../entities/composition/api';
import type { DerivedPoint } from '../../features/derive/DeriveBatch';
import { readApiError } from '../../shared/api/errors';
import type { CompositionVersionDiff } from '../../shared/api/types';
import { Changes } from '../../widgets/composition-renderer/modes/comparison/Comparison';
import { FileDiff } from '../../widgets/composition-renderer/modes/comparison/FileDiff';
import '../../widgets/composition-renderer/CompositionRenderer.css';

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
 * document diff (`POST /v1/compositions/diff`) says what changed, and the comparison view of the Versions tab shows it, with the two
 * texts line by line on request. The two documents are versions of different compositions, so the diff is named after the points.
 */
export function FrontComparison({
  org,
  before,
  after,
  onClose,
}: {
  org: string;
  before: ComparedPoint;
  after: ComparedPoint;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [texts, setTexts] = useState(false);
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
    <Modal title="Compare two points" size="lg" onClose={onClose}>
      <div className="st-compare">
        <p className="org-muted">{`${sideName(before)} compared with ${sideName(after)}: what the gateway finds changed between their documents.`}</p>
        {loaded.status === 'loading' && (
          <p className="org-muted" role="status">
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
            <Changes diff={loaded.diff} />
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
              <FileDiff
                before={loaded.before}
                after={loaded.after}
                beforeLabel={sideName(before)}
                afterLabel={sideName(after)}
              />
            )}
          </>
        )}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose}>
            Done
          </Action>
        </div>
      </div>
    </Modal>
  );
}
