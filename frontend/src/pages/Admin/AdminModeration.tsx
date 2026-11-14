import { RefreshCw } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { AdminEngineReview } from './AdminEngineReview';
import { AdminFrame, AdminOnly, FailureNotice } from './AdminChrome';
import { describeAdminFailure } from './adminModel';

function ModerationScreen() {
  const overview = useResource('admin-moderation-counts', () => apiClient.adminModeration());
  const counts = overview.data ?? overview.stale;
  const failure = overview.status === 'error' ? describeAdminFailure(overview.error, 'The moderation counts couldn’t be loaded') : null;
  const waiting = (map: Record<string, number> | undefined) => (counts ? map?.pending_review ?? 0 : null);
  const tiles: Array<[string, number | null]> = [
    ['Engine requests', waiting(counts?.registrations)],
    ['Engine revisions', waiting(counts?.engines)],
  ];

  return (
    <AdminFrame
      section="moderation"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Moderation' }]}
      title="Moderation"
      lede="Decide what becomes available to everyone: the engine deployments people asked to publish."
      actions={<Action variant="secondary" onClick={overview.reload} busy={overview.status === 'loading' && Boolean(counts)}><RefreshCw aria-hidden="true" />Refresh</Action>}
    >
      {failure && <FailureNotice failure={failure} onRetry={overview.reload} />}
      {overview.status === 'loading' && !counts && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading what waits for review</span><Skeleton variant="tile" /></div>}

      {counts && (
        <div className="adm-queue-tiles" role="list" aria-label="Waiting for review">
          {tiles.map(([label, total]) => (
            <div key={label} role="listitem" className={`adm-queue-tile${total ? ' is-attention' : ''}`}>
              <span>{label}</span>
              <strong>{total ?? '—'}</strong>
            </div>
          ))}
        </div>
      )}

      <AdminEngineReview onDecided={overview.reload} />
    </AdminFrame>
  );
}

/** admin-moderation: the queue of engine publication requests. */
export function AdminModeration() {
  return <AdminOnly><ModerationScreen /></AdminOnly>;
}
