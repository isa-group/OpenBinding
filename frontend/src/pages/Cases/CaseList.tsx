import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { problemPath, problemsPath, workbenchPath } from '../../routes/paths/problems';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { RoleChip } from '../Organization/parts';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import type { CaseContent } from '../../features/workspace/model';
import { classifyAuthError, marker } from '../../shared/api/errors';
import { caseSortKey, newestFirst, plural } from './casesModel';
import { useCreateDialog } from './createDialog';
import { DeleteCaseDialog, UploadProblemDialog } from './dialogs';
import { CaseFrame, ReadOnlyNote } from './parts';
import { loadProblems } from './problemsData';
import { runLaunchOf } from './runTarget';
import { problemAccess } from './useRouteProblem';

/** The template a new problem starts from in the Workbench when the list offers one. */
export const STARTER_TEMPLATE = 'demo/01_simple_seq';

function CaseRow({ org, entry, runHref, canCreate, canAdminister, onDelete }: {
  org: string; entry: CaseContent; runHref: string | null; canCreate: boolean; canAdminister: boolean; onDelete: () => void;
}) {
  const { item } = entry;
  const revisions = newestFirst(entry.revisions);
  const latest = revisions[0];
  return (
    <li className="case-row">
      <Link className="case-row-main" to={problemPath(org, item.slug)} viewTransition>
        <span className="case-row-title">
          <strong>{item.name}</strong>
          <Chip tone={latest ? 'success' : 'plain'}>{latest ? 'Ready to run' : 'No version yet'}</Chip>
        </span>
        <span className="case-row-desc">{item.description || 'No description.'}</span>
        <span className="case-row-meta">
          <span>{plural(revisions.length, 'version')}</span>
          <span aria-hidden="true">·</span>
          <span>{latest ? `latest v${latest.revision} · ${formatDate(latest.created_at) ?? '—'}` : 'latest none yet'}</span>
        </span>
      </Link>
      <span className="case-row-actions">
        {latest && canCreate && runHref && <Action to={runHref} variant="secondary" size="sm">Run latest</Action>}
        {canCreate && <Action to={workbenchPath(org, { problem: item.slug })} variant="secondary" size="sm">New version</Action>}
        {canAdminister && <Action variant="danger-outline" size="sm" onClick={onDelete} aria-label={`Delete ${item.name}`}>Delete</Action>}
      </span>
    </li>
  );
}

function ListBody({ organization }: { organization: Organization }) {
  const location = useLocation();
  const navigate = useNavigate();
  const org = organization.slug;
  const { role, canCreate, canAdminister } = problemAccess(organization);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const dialog = useCreateDialog('problem', problemsPath(org), canCreate);
  // The navigation that closes the dialog can land after the toast renders, so `closing` hides the dialog at once until the address has lost `?create=`.
  const [closing, setClosing] = useState(false);
  if (closing && !dialog.open) setClosing(false);
  const [removing, setRemoving] = useState<CaseContent | null>(null);
  const [toast, setToast] = useState<string>(() => (location.state as { toast?: string } | null)?.toast ?? '');
  const problems = useResource(`problems:${org}`, () => loadProblems(org));

  const all = problems.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = all
    .filter((entry) => !needle || `${entry.item.name} ${entry.item.slug}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === 'name' ? a.item.name.localeCompare(b.item.name) : caseSortKey(b.item, b.revisions) - caseSortKey(a.item, a.revisions)));
  const failure = problems.status === 'error' ? classifyAuthError(problems.error) : null;

  return (
    <CaseFrame organization={organization} trail={[{ label: 'Problems' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Problems</h1>
          <p>A problem describes one experiment. Each package you upload or save is kept as a sealed version you can run, compare and cite.</p>
        </div>
        {canCreate && (
          <div className="proj-actions">
            <Action to={workbenchPath(org)} variant="secondary">Write one in the Workbench</Action>
            <Action to={workbenchPath(org, { template: STARTER_TEMPLATE })} variant="secondary">Start from a template</Action>
            <Action variant="primary" data-create-opener="problem" onClick={dialog.openDialog}>Upload BIM package</Action>
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
        <ReadOnlyNote role={role}>You can open and compare problems here; uploading and editing need MEMBER.</ReadOnlyNote>
      )}

      <div className="case-toolbar">
        <div className="ui-field case-search">
          <label htmlFor="case-search" className="sr-only">Search problems</label>
          <input id="case-search" type="search" value={query} placeholder="Search problems…" onChange={(event) => setQuery(event.target.value)} />
        </div>
        <label className="case-sort">
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value as 'recent' | 'name')}>
            <option value="recent">Latest version</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      {problems.status === 'loading' && (
        <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading problems…</span><Skeleton variant="tile" /><Skeleton variant="tile" /></div>
      )}
      {failure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={problems.reload}>Retry</Action>}>
          {failure.status === 403 ? `Problems can’t be listed with this account or key${marker(failure)}.` : `Problems couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}

      {problems.status === 'ready' && all.length === 0 && (
        <section className="case-guide" aria-labelledby="case-guide-title">
          <h2 id="case-guide-title">No problems yet</h2>
          <p>Upload a BIM package you already have, write one in the Workbench, or start from a template.</p>
          {canCreate && (
            <div className="proj-actions">
              <Action variant="primary" onClick={dialog.openDialog}>Upload BIM package</Action>
              <Action to={workbenchPath(org, { template: STARTER_TEMPLATE })} variant="secondary">Start from a template</Action>
            </div>
          )}
        </section>
      )}
      {problems.status === 'ready' && all.length > 0 && shown.length === 0 && <p className="org-muted">No problem matches “{query.trim()}”.</p>}
      {shown.length > 0 && (
        <ul className="case-list" aria-label="Problems">
          {shown.map((entry) => (
            <CaseRow
              key={entry.item.id}
              org={org}
              entry={entry}
              runHref={entry.revisions.length > 0 ? runLaunchOf(org, entry.item.slug, newestFirst(entry.revisions)[0].revision) : null}
              canCreate={canCreate}
              canAdminister={canAdminister}
              onDelete={() => setRemoving(entry)}
            />
          ))}
        </ul>
      )}
      {problems.status === 'ready' && all.length > 0 && (
        <p className="org-muted">Your role here: <RoleChip role={role} />. Deleting needs ADMIN and works only while no run or study uses the problem.</p>
      )}

      {dialog.open && !closing && (
        <UploadProblemDialog
          organization={organization}
          onClose={dialog.close}
          onCreated={(created) => {
            setClosing(true);
            dialog.close();
            navigate(problemPath(org, created.problem.slug), { state: { toast: `Problem “${created.problem.name}” created with version ${created.revision.revision}.` } });
          }}
        />
      )}
      {removing && (
        <DeleteCaseDialog
          organization={organization}
          item={removing.item}
          onClose={() => setRemoving(null)}
          onDeleted={(name) => {
            setRemoving(null);
            setToast(`Problem “${name}” deleted.`);
            problems.reload();
          }}
        />
      )}
    </CaseFrame>
  );
}

/**
 * Problems (`case-list`, `/app/:org/problems`): the organization's problems, how many versions each has, and the ways to add one. The
 * dialog `Upload BIM package` is open while the address holds `?create=problem`, for the people who may create.
 */
export function CaseList() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  return <ListBody organization={organization} />;
}
