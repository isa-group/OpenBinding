// Pattern only, after SPHERE frontend/src/modules/organization/pages/organization-detail/components/PricingsTab.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the organization's compositions with a version that links a version of this problem
// (`listCompositions?problem=`), as SPHERE's card grid (the composition module's card); under each card, the values the
// gateway gives its latest version and the problem version it links, where the candidates it chose can be highlighted.

import { Link } from 'react-router-dom';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import { compositionsApi } from '../../../core/utils/composition/api';
import { formatValue, valueModels } from '../../../core/utils/composition/values';
import CompositionCard from '../../../composition/components/composition-card';
import { useUpstreamRefresh } from '../../../notification/hooks/useUpstreamRefresh';
import { compositionPath } from '../../../../routes/paths/compositions';
import { problemPath } from '../../../../routes/paths/problems';
import { useResource } from '../../../core/hooks/useResource';
import type { Problem } from '../../api/problemsApi';

/** The most compositions the tab lists. */
const PAGE = 200;

/** The problem version a composition version links, when it is a version of this problem. */
function linkedHere(version: CompositionVersionView, item: Problem): number | null {
  const link = version.problem;
  return link && (link.problem.id === item.id || link.problem.slug === item.slug)
    ? link.revision.revision
    : null;
}

function Linked({
  org,
  item,
  composition,
}: {
  org: string;
  item: Problem;
  composition: CompositionView;
}) {
  const latest = composition.latest_version;
  // The latest version's values are the gateway's, read from the version itself (a list row carries only their status).
  const version = useResource<CompositionVersionView | null>(
    `problem-composition-latest:${org}/${composition.slug}/${latest?.id ?? 'none'}`,
    async () => (latest ? compositionsApi.version(org, composition.slug, latest.id) : null)
  );
  const shown = version.data ?? null;
  const linked = shown ? linkedHere(shown, item) : null;
  const values = shown ? valueModels(shown) : [];
  const link = 'cursor-pointer text-tp-accent hover:underline';
  return (
    <div className="flex flex-col gap-2">
      <CompositionCard
        data={composition}
        to={compositionPath(org, composition.slug)}
        showVisibility
      />
      <div className="flex flex-col gap-1 px-1 text-[11px] text-tp-steel">
        {version.status === 'loading' && <span>Loading its latest version…</span>}
        {version.status === 'error' && (
          <span>
            Its latest version couldn’t be loaded{marker(classifyAuthError(version.error))}
          </span>
        )}
        {shown && values.length === 0 && <span>No values</span>}
        {shown && values.length > 0 && (
          <ul
            className="flex flex-wrap gap-x-3 gap-y-0.5"
            aria-label={`Values of ${composition.name} ${shown.label}`}
          >
            {values.map(value => (
              <li key={`${value.name}-${value.unit}`}>
                <span className="text-tp-slate">{value.name}</span>{' '}
                {formatValue(value.value, value.unit)}
              </li>
            ))}
          </ul>
        )}
        {shown && linked === null && <span>Its latest version links another problem</span>}
        {shown && linked !== null && (
          <span>
            {shown.label} links{' '}
            <Link to={problemPath(org, item.slug, undefined, { version: linked })} className={link}>
              version {linked}
            </Link>
            {' · '}
            <Link
              to={problemPath(org, item.slug, 'candidates', {
                version: linked,
                composition: composition.slug,
                compositionVersion: shown.label,
              })}
              aria-label={`Show ${composition.name} ${shown.label} on the problem`}
              className={link}
            >
              Show on the problem
            </Link>
          </span>
        )}
      </div>
    </div>
  );
}

/** The Compositions tab of the problem page: the compositions that link a version of this problem. */
export default function CompositionsTab({ org, item }: { org: string; item: Problem }) {
  // An upstream event about one of these compositions arrived: their badges are read again.
  const arrived = useUpstreamRefresh(org);
  const list = useResource(`problem-compositions:${org}/${item.slug}:${arrived}`, () =>
    compositionsApi.list(org, { problem: item.slug, sort: 'name', limit: PAGE })
  );
  const rows = list.data?.compositions ?? [];
  const failure = list.status === 'error' ? classifyAuthError(list.error) : null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="pcm-title">
      <div>
        <h2 id="pcm-title" className="text-lg font-medium text-tp-ink">
          Compositions
        </h2>
        <p className="text-xs text-tp-steel">
          The compositions with a version that links a version of this problem. A version derived
          from a run of it, or written against it, links it.
        </p>
      </div>
      {list.status === 'loading' && (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the compositions…</span>
          <Skeleton variant="tile" />
        </div>
      )}
      {failure && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={list.reload}>
              Retry
            </Action>
          }
        >
          {`The compositions couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}
      {list.status === 'ready' && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-tp-hairline-strong p-6 text-center text-sm text-tp-steel">
          No composition links this problem yet.
        </p>
      )}
      {rows.length > 0 && (
        <div
          role="list"
          aria-label="Compositions that link this problem"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {rows.map(composition => (
            <div role="listitem" key={composition.id}>
              <Linked org={org} item={item} composition={composition} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
