import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { platformApi, type Organization, type Project, type ProjectResource } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { Notice } from '../../components/ui/Notice';
import { ProjectLibraryNav } from '../../components/ui/SectionNav';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { RoleChip } from '../Organization/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { ConfirmDialog, NewResourceDialog } from './dialogs';
import { ResourceFrame } from './parts';
import { classifyAuthError, resourceDeleteRefusal, resourcesListRefusal } from './resourceErrors';
import { loadResources } from './resourceData';
import { resourceKindLabel } from './resourceModel';

function Body({ organization, project, access }: { organization: Organization; project: Project; access: ProjectAccess }) {
  const slug = organization.slug;
  const root = `/app/${slug}/${project.slug}`;
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<ProjectResource | null>(null);
  const location = useLocation();
  const [toast, setToast] = useState<{ text: string; open?: string }>(() => ({ text: (location.state as { toast?: string } | null)?.toast ?? '' }));
  const resources = useResource(`resources:${slug}/${project.slug}`, () => loadResources(slug, project.slug));
  const rows = resources.data ?? [];
  const failure = resources.status === 'error' ? classifyAuthError(resources.error) : null;

  return (
    <ResourceFrame organization={organization} project={project} section="library" trail={[{ label: 'Resources' }]}>
      <ProjectLibraryNav current="resources" orgSlug={slug} projectSlug={project.slug} publicRead={access.publicRead} />
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Project resources</h1>
          <p>The older per-project view of resources, kept for tools that use packages. Each one is backed by a library item.</p>
        </div>
        {access.canCreate && <div className="proj-actions"><Action variant="secondary" onClick={() => setCreating(true)}>New resource</Action></div>}
      </header>

      <div className="proj-note is-info res-recommend" role="note">
        <span className="res-note-grow">Recommended: manage workflows, catalogs, rules and goals in the library, where drafts, versions and publishing live.</span>
        <Action to={`/app/${slug}/library`} variant="primary" size="sm">Open the library</Action>
      </div>
      {!access.canCreate && <ReadOnlyNote role={access.role}>You can open resources and their revisions; creating and editing need MEMBER.</ReadOnlyNote>}
      {toast.text && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast.text}</span>
          {toast.open && <Link to={toast.open} viewTransition>Add its first revision</Link>}
        </div>
      )}

      {resources.status === 'loading' && <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading resources…</span><Skeleton variant="panel" /></div>}
      {failure && (
        <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={failure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={resources.reload}>Retry</Action>}>
          {resourcesListRefusal(failure).text}
        </Notice>
      )}
      {resources.status === 'ready' && rows.length === 0 && (
        <section className="lib-dashed lib-nothing" aria-labelledby="res-empty">
          <strong id="res-empty">No project resources</strong>
          <span>That’s normal for new projects: use the library instead.</span>
          <Action to={`/app/${slug}/library`} variant="secondary">Open the library</Action>
        </section>
      )}
      {rows.length > 0 && (
        <DataTable label="Project resources" minWidth={640}>
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Kind</th>
              <th scope="col">Latest revision</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ resource, revisions, known }) => {
              const latest = revisions.reduce<number | null>((best, revision) => (best === null || revision.revision > best ? revision.revision : best), null);
              return (
                <tr key={resource.id}>
                  <td>
                    <Link className="res-name-link" to={`${root}/resources/${encodeURIComponent(resource.slug)}`} viewTransition>{resource.name}</Link>
                    <small className="res-slug">{resource.slug}</small>
                  </td>
                  <td><Chip tone="accent">{resourceKindLabel(resource.kind)}</Chip></td>
                  <td>{!known ? '—' : latest === null ? 'none yet' : `revision ${latest}`}</td>
                  <td>
                    <span className="res-row-actions">
                      {access.canAdminister && <Action variant="danger-outline" size="sm" onClick={() => setRemoving(resource)} aria-label={`Delete ${resource.name}`}>Delete</Action>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      {resources.status === 'ready' && rows.length > 0 && !access.publicRead && (
        <p className="org-muted">Your role here: <RoleChip role={access.role} />. Deleting needs ADMIN and keeps the library versions.</p>
      )}

      {creating && (
        <NewResourceDialog
          organization={organization}
          project={project}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setToast({ text: `Resource “${created.name}” created.`, open: `${root}/resources/${encodeURIComponent(created.slug)}` });
            resources.reload();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          confirmLabel="Delete resource"
          onClose={() => setRemoving(null)}
          run={() => platformApi.deleteResource(slug, project.slug, removing.slug)}
          refusal={(caught) => resourceDeleteRefusal(caught).text}
          onDone={() => {
            setToast({ text: `“${removing.name}” deleted from this project. Library versions stay.` });
            setRemoving(null);
            resources.reload();
          }}
        >
          <p>The resource leaves {project.name}. Its versions stay in the library, and anything that already pinned one keeps working.</p>
        </ConfirmDialog>
      )}
    </ResourceFrame>
  );
}

/** Project resources (`proj-resources`, `/app/:org/:project/resources`): the older view of a project’s resources, each backed by a library item. */
export function ProjResources() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <Body organization={organization} project={project} access={access} />;
}
