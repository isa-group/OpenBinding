// Adapted from SPHERE frontend/src/modules/api-keys/components/ApiKeyList.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: with the layout of its ApiKeyCard, one card per engine registration instead of per key: its name and version with the Active/Inactive and the
// Private, In review, Published or Rejected pills, its namespace, what the publication state means, the last conformance
// check, and its owner's actions (activate or deactivate, request publication, credential, delete); a registration published
// by another account gets none. The empty state invites the first registration. react-icons instead of an inline SVG.

import { MdCloudSync } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { formatDate } from '../../../core/utils/format';
import { Action } from '../../../core/components/action-button';
import type { EngineRegistrationRevision } from '../../api/enginesApi';
import {
  activityOf,
  probeSummary,
  publicationOf,
  registrationHref,
  registrationKey,
  type Probe,
} from '../../api/registrationModel';
import { StatusChip } from '../engine-parts';

interface Props {
  rows: EngineRegistrationRevision[];
  username: string;
  /** The list is the administrators' review queue: no owner actions, a link to review instead. */
  review: boolean;
  isAdmin: boolean;
  /** The last conformance check of each registration, by key; missing while it is read. */
  probes: Record<string, Probe | null>;
  probesLoading: boolean;
  /** The key of the registration a change is on its way for. */
  busy: string;
  createTo: string;
  reviewTo: string;
  onToggle: (row: EngineRegistrationRevision) => void;
  onRequestPublication: (row: EngineRegistrationRevision) => void;
  onDelete: (row: EngineRegistrationRevision) => void;
}

function LastCheck({ probe, loading }: { probe: Probe | null | undefined; loading: boolean }) {
  if (loading) return <span className="text-xs text-tp-steel">Checking…</span>;
  if (!probe) return <span className="text-xs text-tp-steel">Not reported</span>;
  const summary = probeSummary(probe);
  const when = formatDate(probe.verifiedAt);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusChip tone={summary.tone}>{summary.label}</StatusChip>
      {when && <small className="text-xs text-tp-steel">{when}</small>}
    </span>
  );
}

function RegistrationCard({
  row,
  mine,
  review,
  isAdmin,
  probe,
  probeLoading,
  working,
  reviewTo,
  onToggle,
  onRequestPublication,
  onDelete,
}: {
  row: EngineRegistrationRevision;
  mine: boolean;
  review: boolean;
  isAdmin: boolean;
  probe: Probe | null | undefined;
  probeLoading: boolean;
  working: boolean;
  reviewTo: string;
  onToggle: () => void;
  onRequestPublication: () => void;
  onDelete: () => void;
}) {
  const publication = publicationOf(row.status);
  const activity = activityOf(row);
  const owner = mine && !review;
  return (
    <article
      className="rounded-lg border border-tp-hairline bg-tp-canvas p-4"
      aria-label={`${row.name} ${row.version}`}
      data-state={row.status}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MdCloudSync className="h-5 w-5 shrink-0 text-tp-steel" aria-hidden="true" />
          <h3 className="font-medium break-all text-tp-ink">
            <Link
              to={registrationHref(row)}
              className="cursor-pointer hover:text-tp-accent hover:underline"
            >
              {row.name}
            </Link>
          </h3>
          <span className="rounded bg-tp-surface px-1.5 py-0.5 font-mono text-xs text-tp-slate">
            {row.version}
          </span>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <StatusChip tone={activity.tone}>{activity.label}</StatusChip>
          <StatusChip tone={publication.tone}>{publication.label}</StatusChip>
        </span>
      </div>

      <p className="mb-3 text-xs text-tp-steel">
        <span className="font-mono">{row.namespace}</span>
        {!mine && ' · published by another account'} · {publication.text}
      </p>

      <dl className="mb-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-xs font-medium text-tp-steel">Last check</dt>
        <dd>
          <LastCheck probe={probe} loading={probeLoading} />
        </dd>
      </dl>

      {(owner || (review && isAdmin)) && (
        <div className="flex flex-wrap justify-end gap-2">
          {owner && (
            <Action
              size="sm"
              variant="secondary"
              busy={working}
              aria-label={`${row.active ? 'Deactivate' : 'Activate'} ${row.name} ${row.version}`}
              onClick={onToggle}
            >
              {row.active ? 'Deactivate' : 'Activate'}
            </Action>
          )}
          {owner && (row.status === 'private' || row.status === 'rejected') && (
            <Action
              size="sm"
              variant="secondary"
              disabled={working}
              aria-label={`Request publication of ${row.name} ${row.version}`}
              onClick={onRequestPublication}
            >
              Request publication
            </Action>
          )}
          {owner && row.status !== 'published' && (
            <Action
              size="sm"
              variant="ghost"
              to={registrationHref(row, '#credential')}
              aria-label={`Replace the credential of ${row.name} ${row.version}`}
            >
              Credential
            </Action>
          )}
          {review && isAdmin && (
            <Action
              size="sm"
              variant="primary"
              to={reviewTo}
              aria-label={`Review ${row.name} ${row.version}`}
            >
              Review
            </Action>
          )}
          {owner && (
            <Action
              size="sm"
              variant="danger-outline"
              disabled={working}
              aria-label={`Delete ${row.name} ${row.version}`}
              onClick={onDelete}
            >
              Delete
            </Action>
          )}
        </div>
      )}
    </article>
  );
}

/** The account's engine registrations (and the ones published for everyone) as SPHERE's list of API key cards. */
export function MyDeployments({
  rows,
  username,
  review,
  isAdmin,
  probes,
  probesLoading,
  busy,
  createTo,
  reviewTo,
  onToggle,
  onRequestPublication,
  onDelete,
}: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-tp-hairline bg-tp-canvas p-8 text-center">
        <MdCloudSync className="mx-auto h-12 w-12 text-tp-steel" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-medium text-tp-ink">
          {review ? 'Nothing is waiting for review' : 'You haven’t registered an engine'}
        </h3>
        <p className="mt-1 text-sm text-tp-steel">
          {review
            ? 'When someone requests publication of a deployment, it shows up here for administrators.'
            : 'Bring your own solver: register its deployment and use it in your runs. It stays private until reviewed.'}
        </p>
        {!review && (
          <Link
            to={createTo}
            className="mt-3 inline-block cursor-pointer text-sm font-medium text-tp-link hover:underline"
          >
            Register an engine
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3" role="list" aria-label="Engine registrations">
      {rows.map(row => {
        const key = registrationKey(row);
        return (
          <div role="listitem" key={key}>
            <RegistrationCard
              row={row}
              mine={row.namespace === username}
              review={review}
              isAdmin={isAdmin}
              probe={probes[key]}
              probeLoading={probesLoading && !(key in probes)}
              working={busy === key}
              reviewTo={reviewTo}
              onToggle={() => onToggle(row)}
              onRequestPublication={() => onRequestPublication(row)}
              onDelete={() => onDelete(row)}
            />
          </div>
        );
      })}
    </div>
  );
}
