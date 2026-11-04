import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { problemPath, problemsPath } from '../../routes/paths/problems';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { RoleChip } from '../Organization/parts';
import { loadCases } from '../Project/projectData';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { CaseContent } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { classifyAuthError, marker } from './caseErrors';
import { caseSortKey, newestFirst, plural } from './casesModel';
import { useCreateDialog } from './createDialog';
import { DeleteCaseDialog, NewCaseDialog } from './dialogs';
import { CaseFrame, ReadOnlyNote } from './parts';

// [impl->req~frontend-retire-composer-entry-points-repointed~1]
function CaseRow({ root, entry, canCreate, canAdminister, publicRead, onDelete }: {
  root: string; entry: CaseContent; canCreate: boolean; canAdminister: boolean; publicRead: boolean; onDelete: () => void;
}) {
  const { item } = entry;
  const revisions = newestFirst(entry.revisions);
  const latest = revisions[0];
  return (
    <li className="case-row">
      <Link className="case-row-main" to={problemPath(root, item.slug)} viewTransition>
        <span className="case-row-title">
          <strong>{item.name}</strong>
          <Chip tone={latest ? 'success' : 'plain'}>{latest ? 'Ready to run' : 'No version yet'}</Chip>
        </span>
        <span className="case-row-desc">{item.description || 'No description.'}</span>
        <span className="case-row-meta">
          <span>{plural(revisions.length, 'version')}</span>
          <span aria-hidden="true">·</span>
          <span>{latest ? `latest v${latest.revision} · ${formatDate(latest.created_at) ?? '—'}` : 'latest none yet'}</span>        </span>
      </Link>
      <span className="case-row-actions">
        {latest && !publicRead && <Action to={`${root}/runs/new?case=${encodeURIComponent(item.slug)}&revision=${latest.revision}`} variant="secondary" size="sm">Run latest</Action>}
        {canCreate && <Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="secondary" size="sm">New version</Action>}
        {canAdminister && <Action variant="danger-outline" size="sm" onClick={onDelete} aria-label={`Delete ${item.name}`}>Delete</Action>}
      </span>
    </li>
  );
}

function ListBody({ organization, project, canCreate, canAdminister, role }: {
  organization: Organization; project: Project; canCreate: boolean; canAdminister: boolean; role: Organization['effective_role'];
}) {
  const location = useLocation();
  const root = `/app/${organization.slug}/${project.slug}`;
  const publicRead = project.access === 'public_read';
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const dialog = useCreateDialog('problem', problemsPath(root), canCreate);
  // The navigation that closes the dialog can land after the toast renders, so `closing` hides the dialog at once until the address has lost `?create=`.
  const [closing, setClosing] = useState(false);
  if (closing && !dialog.open) setClosing(false);
  const [removing, setRemoving] = useState<CaseContent | null>(null);
  const [toast, setToast] = useState<{ text: string; compose?: string }>(() => ({
    text: (location.state as { toast?: string } | null)?.toast ?? '',
  }));
  const cases = useResource(`cases:${organization.slug}/${project.slug}`, () => loadCases(organization.slug, project.slug));

  const all = cases.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = all
    .filter((entry) => !needle || `${entry.item.name} ${entry.item.slug}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === 'name' ? a.item.name.localeCompare(b.item.name) : caseSortKey(b.item, b.revisions) - caseSortKey(a.item, a.revisions)));
  const failure = cases.status === 'error' ? classifyAuthError(cases.error) : null;

  return (
    <CaseFrame organization={organization} project={project} trail={[{ label: 'Problems' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Problems</h1>
          <p>A problem describes one experiment. Each change is kept as a sealed version you can run, compare and cite.</p>
        </div>
        {canCreate && (
          <div className="proj-actions">
            <Action to={`${root}/workbench`} variant="secondary">Workbench</Action>
            <Action to="/explore/examples" variant="secondary">Import from example</Action>
            <Action variant="primary" data-create-opener="problem" onClick={dialog.openDialog}>New problem</Action>
          </div>
        )}
      </header>

      {toast.text && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast.text}</span>
          {toast.compose && <Link to={toast.compose} viewTransition>Compose its first version</Link>}
        </div>
      )}
      {!canCreate && (
        <ReadOnlyNote role={role}>You can open and compare problems here; creating and editing need MEMBER.</ReadOnlyNote>
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

      {cases.status === 'loading' && (
        <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading problems…</span><Skeleton variant="tile" /><Skeleton variant="tile" /></div>
      )}
      {failure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={cases.reload}>Retry</Action>}>
          {failure.status === 403 ? `Problems can’t be listed with this account or key${marker(failure)}.` : `Problems couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}

      {cases.status === 'ready' && all.length === 0 && (
        <section className="case-guide" aria-labelledby="case-guide-title">
          <h2 id="case-guide-title">No problems yet</h2>
          {publicRead ? <p>This project hasn’t shared any problem yet.</p> : (
            <>
              <p>Start from a ready example, or create a problem and save its first version from the workbench.</p>
              <div className="proj-actions">
                <Action to="/explore/examples" variant="primary">Import an example</Action>
              </div>
            </>
          )}
        </section>
      )}
      {cases.status === 'ready' && all.length > 0 && shown.length === 0 && <p className="org-muted">No problem matches “{query.trim()}”.</p>}
      {shown.length > 0 && (
        <ul className="case-list" aria-label="Problems">
          {shown.map((entry) => (
            <CaseRow key={entry.item.id} root={root} entry={entry} canCreate={canCreate} canAdminister={canAdminister} publicRead={publicRead} onDelete={() => setRemoving(entry)} />
          ))}
        </ul>
      )}
      {cases.status === 'ready' && all.length > 0 && !publicRead && (
        <p className="org-muted">Your role here: <RoleChip role={role} />. Deleting needs ADMIN and works only while a problem has no sealed version.</p>
      )}

      {dialog.open && !closing && (
        <NewCaseDialog
          organization={organization}
          project={project}
          onClose={dialog.close}
          onCreated={(created) => {
            setClosing(true);
            dialog.close();
            setToast({ text: `Problem “${created.name}” created. Compose its first version when you’re ready.`, compose: `${root}/workbench?case=${encodeURIComponent(created.slug)}` });
            cases.reload();
          }}
        />
      )}
      {removing && (
        <DeleteCaseDialog
          organization={organization}
          project={project}
          item={removing.item}
          sealed={removing.revisions.length}
          onClose={() => setRemoving(null)}
          onDeleted={(name) => {
            setRemoving(null);
            setToast({ text: `Problem “${name}” deleted.` });
            cases.reload();
          }}
        />
      )}
    </CaseFrame>
  );
}

/**
 * Problems (`case-list`, `/app/:org/:project/problems`): the project’s problems, how many versions each has, and the way to create one. The dialog
 * `New problem` is open while the address holds `?create=problem`, for the people who may create.
 */
// [impl->req~frontend-nav-new-menu~1]
export function CaseList() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <ListBody organization={organization} project={project} canCreate={access.canCreate} canAdminister={access.canAdminister} role={access.role} />;
}
