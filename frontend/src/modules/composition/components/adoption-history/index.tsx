// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-versions-tab/index.tsx (revision fc776b4d),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: through OpenBinding's versions tab (`VersionRow`): the rows of an environment's adoption history instead of a
// pricing's versions, newest first, in the same hairline list. The adoption in effect is tinted with an "In effect" pill
// (where SPHERE says "Current"); each row says what it replaced, who adopted it and when, its note, the evaluation it pinned
// and the offering version that evaluation read, and offers "Compare previous" (the Versions tab's pair) and "Copy link".

import { formatDistanceToNow, parseISO } from 'date-fns';
import { FiColumns, FiCopy } from 'react-icons/fi';
import { Link } from 'react-router-dom';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type { CompositionAdoptionView } from '../../../core/api/types';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { useCopy } from '../../../core/hooks/useCopy';
import { useResource } from '../../../core/hooks/useResource';
import { compositionPath } from '../../../../routes/paths/compositions';
import { useEnvironmentsApi } from '../../api/environmentsApi';

const iconButton =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink';

interface Props {
  org: string;
  composition: string;
  environment: string;
  /** The adoption in effect (its ordinal), tinted in the list. */
  inEffect: number | null;
  /** Changes when an adoption was made, so the list is read again. */
  refresh?: string;
}

function AdoptionRow({
  org,
  composition,
  adoption,
  current,
}: {
  org: string;
  composition: string;
  adoption: CompositionAdoptionView;
  current: boolean;
}) {
  const { copy, status } = useCopy();
  const page = compositionPath(org, composition, undefined, { version: adoption.version.label });
  const previous = adoption.previousVersion;
  const by = adoption.adoptedBy ? ` by ${adoption.adoptedBy.displayName}` : '';
  // A confirmed proposal's adoption says so (F6); a direct one says nothing more.
  const through = adoption.source === 'proposal' ? ', through a proposal' : '';
  return (
    <li
      aria-label={`Adoption ${adoption.ordinal}`}
      aria-current={current ? 'true' : undefined}
      className={`flex flex-col gap-2 px-4 py-3 lg:flex-row lg:items-start lg:justify-between ${current ? 'bg-tp-primary/5' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] font-medium text-tp-steel">#{adoption.ordinal}</span>
          <span className="text-sm text-tp-ink">
            {previous ? (
              <>
                <span className="font-mono">{previous.label}</span>
                {' → '}
              </>
            ) : null}
            <Link
              to={page}
              title="View this version"
              className="font-mono font-medium hover:text-tp-accent hover:underline"
            >
              {adoption.version.label}
            </Link>
          </span>
          {current && (
            <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
              In effect
            </span>
          )}
          {adoption.evaluation && <ValueBadge status={adoption.evaluation.valuesStatus} compact />}
          <span className="text-[11px] text-tp-steel">
            {`${formatDistanceToNow(parseISO(adoption.adoptedAt))} ago${by}${through}`}
          </span>
        </div>
        {adoption.note && <p className="mt-1 text-xs text-tp-slate">{adoption.note}</p>}
        {adoption.offering?.versionName && (
          <p className="mt-1 text-[11px] text-tp-steel">
            Offering version {adoption.offering.versionName}, read when this version was evaluated.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {previous && (
          <Link
            to={compositionPath(org, composition, 'versions', {
              from: previous.label,
              to: adoption.version.label,
            })}
            className={iconButton}
          >
            <FiColumns className="h-4 w-4" aria-hidden="true" />
            Compare previous
          </Link>
        )}
        <button
          type="button"
          onClick={() => void copy(`${window.location.origin}${page}`, adoption.version.id)}
          className={iconButton}
        >
          <FiCopy className="h-4 w-4" aria-hidden="true" />
          {status(adoption.version.id) === 'copied'
            ? 'Link copied'
            : status(adoption.version.id) === 'failed'
              ? 'Copy failed'
              : 'Copy link'}
        </button>
      </div>
    </li>
  );
}

export default function AdoptionHistory({
  org,
  composition,
  environment,
  inEffect,
  refresh = '',
}: Props) {
  const api = useEnvironmentsApi();
  const history = useResource(`adoptions:${org}/${composition}/${environment}:${refresh}`, () =>
    api.listAdoptions(org, composition, environment, { limit: 20 })
  );
  const failure = history.status === 'error' ? classifyAuthError(history.error) : null;
  const rows = history.data?.adoptions ?? history.stale?.adoptions ?? [];
  return (
    <section
      aria-labelledby={`history-${environment}`}
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="border-b border-tp-hairline px-5 py-3">
        <h3 id={`history-${environment}`} className="text-sm font-semibold text-tp-ink">
          Adoption history
        </h3>
        <p className="text-xs text-tp-steel">
          Every adoption, newest first. Nothing here is ever changed.
        </p>
      </div>
      {failure ? (
        <p role="alert" className="px-5 py-4 text-sm text-red-800">
          {`The history couldn’t be loaded${marker(failure)}.`}{' '}
          <button type="button" onClick={history.reload} className="underline">
            Retry
          </button>
        </p>
      ) : history.status === 'loading' && rows.length === 0 ? (
        <p role="status" className="px-5 py-4 text-sm text-tp-steel">
          Loading the history…
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-tp-steel">Nothing has been adopted here yet.</p>
      ) : (
        <ul className="divide-y divide-tp-hairline">
          {rows.map(adoption => (
            <AdoptionRow
              key={adoption.ordinal}
              org={org}
              composition={composition}
              adoption={adoption}
              current={adoption.ordinal === inEffect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
