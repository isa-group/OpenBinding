// Pattern only, after SPHERE frontend/src/modules/organization/pages/organization-detail/components/MembersTab.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's member row (a hairline row that tints on hover, an avatar and a name) holds one run of an organization:
// its status pill, problem@version, engine, outcome, the time it took, who launched it and when, Open and Retry; on a phone
// the columns stack into two lines.

import { Link } from 'react-router-dom';
import UserAvatar from '../../../core/components/user-avatar';
import { runLabel } from '../../../core/utils/identity';
import { formatDateTime } from '../../../core/utils/format';
import { problemPath } from '../../../../routes/paths/problems';
import { runPath } from '../../../../routes/paths/runs';
import type { Job } from '../../api/runsApi';
import {
  canRetryState,
  formatTook,
  isActive,
  normalizeStatus,
  tookOf,
  tookPercent,
} from '../../utils/runsModel';
import { OutcomeChip, StatusChip } from '../run-status';

/** The columns of a run row from `sm` up; the header of the list uses the same template. */
export const RUN_ROW_COLUMNS =
  'sm:grid sm:grid-cols-[7.5rem_minmax(0,1.4fr)_minmax(0,1fr)_7rem_6.5rem_minmax(0,1.2fr)_5.5rem] sm:items-center sm:gap-3';

interface Props {
  org: string;
  job: Job;
  /** The signed-in account, to say "You". */
  me?: string | null;
  /** MEMBER: may retry a failed or cancelled run. */
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}

export default function RunRow({ org, job, me, canRetry, retrying, onRetry }: Props) {
  const state = normalizeStatus(job.status);
  const took = tookOf(job);
  const own = Boolean(me && job.created_by?.id === me);
  const launcher = own ? 'You' : (job.created_by?.username ?? 'Another member');
  const label = runLabel({ engine: { name: job.engine_id }, createdAt: job.created_at });
  return (
    <li
      aria-label={label}
      className={`flex flex-col gap-2 px-5 py-3 transition-colors hover:bg-tp-surface/50 ${RUN_ROW_COLUMNS}`}
    >
      <div className="flex items-center justify-between gap-2 sm:block">
        <StatusChip status={state} />
        <span className="text-[11px] text-tp-steel sm:hidden">
          {formatDateTime(job.created_at) ?? ''}
        </span>
      </div>
      <div className="min-w-0 text-sm">
        {job.problem ? (
          <Link
            to={problemPath(org, job.problem.slug, undefined, {
              version: job.revision?.revision,
            })}
            className="cursor-pointer font-medium [overflow-wrap:anywhere] text-tp-ink hover:text-tp-accent hover:underline"
          >
            {job.problem.name}
            {job.revision && (
              <span className="font-normal text-tp-steel">@v{job.revision.revision}</span>
            )}
          </Link>
        ) : (
          <span className="text-tp-steel">—</span>
        )}
      </div>
      <div className="min-w-0 text-sm">
        <span className="font-mono text-xs [overflow-wrap:anywhere] text-tp-ink">
          {job.engine_id}
        </span>
        {job.retry_of_id && (
          <span className="block text-[11px] text-tp-steel">Retry of an earlier run</span>
        )}
      </div>
      <div>
        {state === 'completed' ? (
          <OutcomeChip termination={job.termination} />
        ) : (
          <span className="text-tp-steel" aria-label="No outcome yet">
            —
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-tp-slate tabular-nums">
        <span
          className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-tp-hairline sm:block"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full bg-tp-primary"
            style={{ width: `${tookPercent(took)}%` }}
          />
        </span>
        <span>
          <span className="text-tp-steel sm:hidden">Took </span>
          {took !== null
            ? formatTook(took)
            : isActive(state)
              ? state === 'running'
                ? 'running'
                : 'waiting'
              : '—'}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <UserAvatar username={job.created_by?.username ?? '?'} size={24} />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium text-tp-ink">{launcher}</span>
          <span className="hidden truncate text-[11px] text-tp-steel sm:block">
            {formatDateTime(job.created_at) ?? '—'}
          </span>
        </span>
      </div>
      <div className="flex items-center gap-3 sm:justify-end">
        <Link
          to={runPath(org, job.id)}
          aria-label={`Open ${label}`}
          className="cursor-pointer text-xs font-medium text-tp-accent hover:underline"
        >
          Open
        </Link>
        {canRetry && canRetryState(state) && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="cursor-pointer text-xs font-medium text-tp-accent hover:underline disabled:cursor-wait disabled:opacity-60"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    </li>
  );
}
