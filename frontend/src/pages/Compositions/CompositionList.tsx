import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Layers } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { compositionsApi } from '../../entities/composition/api';
import { KIND_OPTIONS, isKind, kindLabel } from '../../entities/composition/kinds';
import { valueStatus } from '../../entities/composition/values';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { compositionPath, compositionsPath } from '../../routes/paths/compositions';
import { classifyAuthError, marker } from '../../shared/api/errors';
import type { CompositionView } from '../../shared/api/types';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ValueBadge } from '../../widgets/value-badge/ValueBadge';
import { useCreateDialog } from '../Problems/createDialog';
import { ReadOnlyNote } from '../Problems/parts';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { CompositionFrame } from './parts';
import { CreateCompositionDialog } from './CreateCompositionDialog';
import { compositionAccess } from './useRouteComposition';

/** The most compositions one page lists. */
const PAGE = 200;
/** How long the search waits after the last keystroke before it asks again. */
const SEARCH_DELAY = 300;

const KIND_PILLS = [{ id: 'all', label: 'All kinds' }, ...KIND_OPTIONS];
const STATE_PILLS = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
];

/** The status of the latest version's values: declared, or verified or not by its current evaluation. */
function LatestValues({ composition }: { composition: CompositionView }) {
  const latest = composition.latest_version;
  if (!latest) return <span className="org-muted">—</span>;
  return <ValueBadge status={valueStatus(latest)} />;
}

function Row({ org, composition }: { org: string; composition: CompositionView }) {
  return (
    <tr>
      <th scope="row">
        <span className="cmp-name">
          <Link to={compositionPath(org, composition.slug)} viewTransition>
            {composition.name}
          </Link>
          {composition.archived && <Badge variant="warning">Archived</Badge>}
        </span>
        <code className="cmp-slug">{composition.slug}</code>
      </th>
      <td>{kindLabel(composition.kind)}</td>
      <td>
        {composition.latest_version ? (
          <code>{composition.latest_version.label}</code>
        ) : (
          <span className="org-muted">No version yet</span>
        )}
      </td>
      <td>
        <LatestValues composition={composition} />
      </td>
      <td>
        <Badge variant={composition.visibility === 'public' ? 'info' : 'default'}>
          {composition.visibility === 'public' ? 'Public' : 'Private'}
        </Badge>
      </td>
      <td className="cmp-number">{composition.version_count ?? 0}</td>
      <td>{formatDate(composition.updated_at) ?? '—'}</td>
    </tr>
  );
}

function ListBody({ organization }: { organization: Organization }) {
  const org = organization.slug;
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { role, canCreate } = compositionAccess(organization);
  // What the screen that led here did (a composition deleted).
  const toast = (location.state as { toast?: string } | null)?.toast ?? '';
  const kindParam = params.get('kind');
  const kind = isKind(kindParam) ? kindParam : undefined;
  const archived = params.get('archived') === 'true';
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const dialog = useCreateDialog('composition', compositionsPath(org), canCreate);
  const filtered = Boolean(kind) || archived || q.trim() !== '';

  const show = (next: { kind?: typeof kind; archived?: boolean; q?: string }) =>
    void navigate(compositionsPath(org, { kind, archived, q, ...next }), { replace: true });

  useEffect(() => {
    if (text.trim() === q.trim()) return undefined;
    const timer = window.setTimeout(
      () => void navigate(compositionsPath(org, { kind, archived, q: text }), { replace: true }),
      SEARCH_DELAY
    );
    return () => window.clearTimeout(timer);
  }, [text, q, kind, archived, org, navigate]);

  const compositions = useResource(
    `compositions:${org}:${kind ?? 'all'}:${archived}:${q.trim()}`,
    () =>
      compositionsApi.list(org, {
        kind,
        archived,
        q: q.trim() || undefined,
        sort: 'updated',
        limit: PAGE,
      })
  );
  const rows = compositions.data?.compositions ?? [];
  const failure = compositions.status === 'error' ? classifyAuthError(compositions.error) : null;

  return (
    <CompositionFrame organization={organization} trail={[{ label: 'Compositions' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Compositions</h1>
          <p>
            A composition binds each task of a workflow to a service, or keeps it in-house, and
            records the values that binding gives. Every version is sealed, so it can be opened,
            compared and cited.
          </p>
        </div>
        {canCreate && (
          <div className="proj-actions">
            <Action variant="primary" data-create-opener="composition" onClick={dialog.openDialog}>
              New composition
            </Action>
          </div>
        )}
      </header>

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
        </div>
      )}
      {!canCreate && (
        <ReadOnlyNote role={role}>
          You can open and read compositions here; creating them and sealing versions need MEMBER.
        </ReadOnlyNote>
      )}

      <div className="cmp-toolbar">
        <div className="ui-field cmp-search">
          <label htmlFor="cmp-search" className="sr-only">
            Search compositions
          </label>
          <input
            id="cmp-search"
            type="search"
            value={text}
            placeholder="Search compositions…"
            onChange={event => setText(event.target.value)}
          />
        </div>
        <FilterPills
          ariaLabel="Kind"
          options={KIND_PILLS}
          value={kind ?? 'all'}
          onChange={id => show({ kind: isKind(id) ? id : undefined })}
        />
        <FilterPills
          ariaLabel="State"
          options={STATE_PILLS}
          value={archived ? 'archived' : 'active'}
          onChange={id => show({ archived: id === 'archived' })}
        />
      </div>

      {compositions.status === 'loading' && (
        <div role="status" aria-busy="true" className="cmp-skeletons">
          <span className="sr-only">Loading compositions…</span>
          <Skeleton variant="tile" />
          <Skeleton variant="tile" />
        </div>
      )}
      {failure && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={compositions.reload}>
              Retry
            </Action>
          }
        >
          {failure.status === 403
            ? `Compositions can’t be listed with this account or key${marker(failure)}.`
            : `Compositions couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}

      {compositions.status === 'ready' && rows.length === 0 && !filtered && (
        <EmptyState
          dashed
          icon={<Layers />}
          title="No compositions yet"
          action={
            canCreate ? (
              <Action variant="primary" onClick={dialog.openDialog}>
                New composition
              </Action>
            ) : undefined
          }
        >
          A composition starts empty; its versions are Composition2Yaml documents you seal, write by
          hand or derive from a run.
        </EmptyState>
      )}
      {compositions.status === 'ready' && rows.length === 0 && filtered && (
        <EmptyState icon={<Layers />} title="No composition matches">
          Nothing here has{' '}
          {[
            kind && `the kind ${kindLabel(kind)}`,
            q.trim() && `“${q.trim()}” in its name or address`,
            archived && 'been archived',
          ]
            .filter(Boolean)
            .join(', ') || 'these filters'}
          .
        </EmptyState>
      )}
      {rows.length > 0 && (
        <DataTable label="Compositions" minWidth={780}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Latest version</th>
              <th scope="col">Values</th>
              <th scope="col">Visibility</th>
              <th scope="col">Versions</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(composition => (
              <Row key={composition.id} org={org} composition={composition} />
            ))}
          </tbody>
        </DataTable>
      )}

      {dialog.open && (
        <CreateCompositionDialog
          organization={organization}
          onClose={dialog.close}
          onCreated={created =>
            navigate(compositionPath(org, created.slug, 'editor'), {
              state: {
                toast: `Composition “${created.name}” created. It has no version yet: write its first one here.`,
              },
            })
          }
        />
      )}
    </CompositionFrame>
  );
}

/**
 * Compositions (`composition-list`, `/app/:org/compositions`): the organization's compositions with their latest version, the
 * status of its values and who reads them, filtered by kind, state and text. `New composition` is open while the address holds
 * `?create=composition`, for the people who may create.
 */
export function CompositionList() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  return <ListBody organization={organization} />;
}
