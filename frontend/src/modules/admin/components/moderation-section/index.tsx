import { MdRefresh } from 'react-icons/md';
import { Action } from '../../../core/components/action-button';
import { Skeleton } from '../../../core/components/skeleton';
import { useResource } from '../../../../utils/useResource';
import { useAdminApi } from '../../api/adminApi';
import { describeAdminFailure } from '../../utils/adminModel';
import EngineReview from '../engine-review';
import { FailureNotice, Loading, SectionHeader } from '../admin-parts';

/** The Moderation section of `/admin`: what waits for a decision, and the queue of engine publication requests. */
export default function ModerationSection() {
  const api = useAdminApi();
  const overview = useResource('admin-moderation-counts', () => api.adminModeration());
  const counts = overview.data ?? overview.stale;
  const failure =
    overview.status === 'error'
      ? describeAdminFailure(overview.error, 'The moderation counts couldn’t be loaded')
      : null;
  const waiting = (map: Record<string, number> | undefined) =>
    counts ? (map?.pending_review ?? 0) : null;
  const tiles: Array<[string, number | null]> = [
    ['Engine requests', waiting(counts?.registrations)],
    ['Engine revisions', waiting(counts?.engines)],
  ];

  return (
    <>
      <SectionHeader
        title="Moderation"
        lede="Decide what becomes available to everyone: the engine deployments people asked to publish."
        actions={
          <Action
            variant="secondary"
            onClick={overview.reload}
            busy={overview.status === 'loading' && Boolean(counts)}
          >
            <MdRefresh aria-hidden="true" />
            Refresh
          </Action>
        }
      />
      {failure && <FailureNotice failure={failure} onRetry={overview.reload} />}
      {overview.status === 'loading' && !counts && (
        <Loading label="Loading what waits for review">
          <Skeleton variant="tile" />
        </Loading>
      )}

      {counts && (
        <div
          className="grid grid-cols-2 gap-3 sm:max-w-[28rem]"
          role="list"
          aria-label="Waiting for review"
        >
          {tiles.map(([label, total]) => (
            <div
              key={label}
              role="listitem"
              className={`flex flex-col gap-1 rounded-xl border bg-tp-canvas p-3 ${
                total ? 'border-tp-severity-warning-border' : 'border-tp-hairline'
              }`}
            >
              <span className="text-[11px] text-tp-steel">{label}</span>
              <strong className="text-lg font-semibold text-tp-ink">{total ?? '—'}</strong>
            </div>
          ))}
        </div>
      )}

      <EngineReview onDecided={overview.reload} />
    </>
  );
}
