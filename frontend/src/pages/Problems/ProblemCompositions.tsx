import { Link } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import type { Problem } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { compositionsApi } from '../../entities/composition/api';
import { formatValue, valueModels, valueStatus } from '../../entities/composition/values';
import { compositionPath } from '../../routes/paths/compositions';
import { problemPath } from '../../routes/paths/problems';
import { classifyAuthError, marker } from '../../shared/api/errors';
import type { CompositionVersionView, CompositionView } from '../../shared/api/types';
import { useResource } from '../../utils/useResource';
import { ValueBadge } from '../../widgets/value-badge/ValueBadge';

/** The most compositions the tab lists. */
const PAGE = 200;

/** The problem version a composition version links, when it is a version of this problem. */
function linkedHere(version: CompositionVersionView, item: Problem): number | null {
  const link = version.problem;
  return link && (link.problem.id === item.id || link.problem.slug === item.slug) ? link.revision.revision : null;
}

function Row({ org, item, composition }: { org: string; item: Problem; composition: CompositionView }) {
  const latest = composition.latest_version;
  // The latest version's values are the gateway's, read from the version itself (a list row carries only their status).
  const version = useResource<CompositionVersionView | null>(
    `problem-composition-latest:${org}/${composition.slug}/${latest?.id ?? 'none'}`,
    async () => (latest ? compositionsApi.version(org, composition.slug, latest.id) : null),
  );
  const shown = version.data ?? null;
  const linked = shown ? linkedHere(shown, item) : null;
  const values = shown ? valueModels(shown) : [];
  return (
    <tr>
      <th scope="row">
        <Link to={compositionPath(org, composition.slug)} viewTransition>{composition.name}</Link>
        <code className="case-slug">{composition.slug}</code>
      </th>
      <td>
        {latest ? (
          <>
            <Link to={compositionPath(org, composition.slug, undefined, { version: latest.label })} viewTransition>{latest.label}</Link>
            {' '}<ValueBadge status={valueStatus(latest)} />
          </>
        ) : <span className="org-muted">No version yet</span>}
      </td>
      <td>
        {version.status === 'loading' && <span className="org-muted">Loading…</span>}
        {version.status === 'error' && <span className="org-muted">Couldn’t be loaded{marker(classifyAuthError(version.error))}</span>}
        {shown && values.length === 0 && <span className="org-muted">No values</span>}
        {values.length > 0 && (
          <ul className="case-values" aria-label={`Values of ${composition.name} ${shown?.label ?? ''}`}>
            {values.map((value) => <li key={`${value.name}-${value.unit}`}><span>{value.name}</span> {formatValue(value.value, value.unit)}</li>)}
          </ul>
        )}
      </td>
      <td>
        {shown && linked === null && <span className="org-muted">Links another problem</span>}
        {shown && linked !== null && (
          <>
            <Link to={problemPath(org, item.slug, undefined, { version: linked })} viewTransition>Version {linked}</Link>
            {' · '}
            <Link
              to={problemPath(org, item.slug, 'candidates', { version: linked, composition: composition.slug, compositionVersion: shown.label })}
              aria-label={`Show ${composition.name} ${shown.label} on the problem`}
              viewTransition
            >
              Show on the problem
            </Link>
          </>
        )}
      </td>
    </tr>
  );
}

/**
 * Compositions: the organization's compositions with a version that links a version of this problem (`listCompositions?problem=`),
 * each with its latest version, the values the gateway gives that version, and the problem version it links, where the candidates
 * it chose can be highlighted.
 */
export function ProblemCompositions({ organization, item }: { organization: Organization; item: Problem }) {
  const org = organization.slug;
  const list = useResource(`problem-compositions:${org}/${item.slug}`, () => compositionsApi.list(org, { problem: item.slug, sort: 'name', limit: PAGE }));
  const rows = list.data?.compositions ?? [];
  const failure = list.status === 'error' ? classifyAuthError(list.error) : null;
  return (
    <section className="org-section" aria-labelledby="pcm-title">
      <h2 id="pcm-title">Compositions</h2>
      <p className="org-muted">The compositions with a version that links a version of this problem. A version derived from a run of it, or written against it, links it.</p>
      {list.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Loading the compositions…</span><Skeleton variant="tile" /></div>}
      {failure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={list.reload}>Retry</Action>}>
          {`The compositions couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}
      {list.status === 'ready' && rows.length === 0 && <p className="org-muted">No composition links this problem yet.</p>}
      {rows.length > 0 && (
        <DataTable label="Compositions that link this problem" minWidth={720}>
          <thead>
            <tr>
              <th scope="col">Composition</th>
              <th scope="col">Latest version</th>
              <th scope="col">Values</th>
              <th scope="col">Problem version</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((composition) => <Row key={composition.id} org={org} item={item} composition={composition} />)}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
