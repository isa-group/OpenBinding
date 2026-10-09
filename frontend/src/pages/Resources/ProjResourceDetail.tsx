import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { platformApi, type Organization, type Project, type ProjectResource, type ProjectResourceRevision } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote, DigestLine } from '../Cases/parts';
import { ContentView } from '../Library/ContentView';
import { isObject, jsonEqual, type Content, type JsonObject } from '../Library/contentModel';
import { DocumentForm } from '../Library/DocumentForm';
import { Gate } from '../Organization/parts';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { ConfirmDialog, EditResourceDialog } from './dialogs';
import { ResourceFrame } from './parts';
import { classifyAuthError, isMissing, resourceDeleteRefusal, resourceRevisionRefusal, marker } from './resourceErrors';
import { plural, resourceKindLabel } from './resourceModel';

const latestOf = (revisions: readonly ProjectResourceRevision[]): ProjectResourceRevision | undefined =>
  revisions.reduce<ProjectResourceRevision | undefined>((best, revision) => (!best || revision.revision > best.revision ? revision : best), undefined);

function RevisionItem({ revision, kind, latest }: { revision: ProjectResourceRevision; kind: string; latest: boolean }) {
  const [open, setOpen] = useState(false);
  const created = formatDateTime(revision.created_at);
  return (
    <li className="res-revision">
      <div className="res-revision-head">
        <strong>Revision {revision.revision}</strong>
        {latest && <Chip tone="success">Latest</Chip>}
        <small>Library version {revision.revision}{created ? ` · ${created}` : ''}</small>
        <DigestLine digest={revision.digest} label={`revision ${revision.revision}`} copyKey={`rev-${revision.revision}`} />
        <Action variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} what revision ${revision.revision} holds`}>
          {open ? 'Hide contents' : 'Show contents'}
        </Action>
      </div>
      {open && <div className="res-revision-body"><ContentView kind={kind} content={revision.document as JsonObject} /></div>}
    </li>
  );
}

function RevisionEditor({ resource, revisions, organization, project, onSaved, onCancel }: {
  resource: ProjectResource; revisions: readonly ProjectResourceRevision[]; organization: Organization; project: Project;
  onSaved: (saved: ProjectResourceRevision, previous: number) => void; onCancel: () => void;
}) {
  const latest = latestOf(revisions);
  const start: JsonObject = latest && isObject(latest.document) ? (latest.document as JsonObject) : {};
  const [draft, setDraft] = useState<JsonObject>(start);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const unchanged = latest !== undefined && jsonEqual(draft, start);

  useEffect(() => { heading.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await platformApi.createResourceRevision(organization.slug, project.slug, resource.slug, draft), latest?.revision ?? 0);
    } catch (caught) {
      setError(resourceRevisionRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <form className="res-editor" aria-labelledby="rd-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header>
        <h2 id="rd-editor" tabIndex={-1} ref={heading}>{latest ? `New revision · change what differs from revision ${latest.revision}` : 'First revision · fill in what this resource holds'}</h2>
        <span className="lib-footnote">Saving seals it: earlier revisions never change.</span>
      </header>
      <DocumentForm kind={resource.kind} content={draft as Content} onChange={(next) => { if (isObject(next)) { setDraft(next); setError(undefined); } }} readOnly={busy} />
      <div aria-live="assertive">
        {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
      </div>
      <div className="proj-actions">
        <Action type="submit" variant="primary" busy={busy} disabled={unchanged}>Save revision</Action>
        <Action variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Action>
        {latest && unchanged && <span className="lib-footnote">Nothing differs from revision {latest.revision} yet.</span>}
      </div>
    </form>
  );
}

function Body({ organization, project, access, resourceSlug }: { organization: Organization; project: Project; access: ProjectAccess; resourceSlug: string }) {
  const slug = organization.slug;
  const root = `/app/${slug}/${project.slug}`;
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [toast, setToast] = useState('');
  const found = useResource(`resource:${slug}/${project.slug}/${resourceSlug}`, () => platformApi.resource(slug, project.slug, resourceSlug));
  const revisions = useResource(`resource-revisions:${slug}/${project.slug}/${resourceSlug}`, () => platformApi.resourceRevisions(slug, project.slug, resourceSlug));
  const resource = found.data ?? found.stale;
  const failure = found.status === 'error' ? classifyAuthError(found.error) : null;
  const trail = [{ label: 'Resources', to: `${root}/resources` }, { label: resource?.name ?? resourceSlug }];

  if (failure && !resource) {
    return (
      <ResourceFrame organization={organization} project={project} section="library" trail={trail}>
        {isMissing(failure)
          ? (
            <Gate title="Resource not found" action={<Action to={`${root}/resources`} variant="primary">All resources</Action>}>
              This resource doesn’t exist in {project.name}{marker(failure)}.
            </Gate>
          )
          : (
            <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={failure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={found.reload}>Retry</Action>}>
              {failure.status === 403 ? `This account or API key can’t read this resource${marker(failure)}.` : `The resource couldn’t be loaded${marker(failure)}.`}
            </Notice>
          )}
      </ResourceFrame>
    );
  }
  if (!resource) {
    return (
      <ResourceFrame organization={organization} project={project} section="library" trail={trail}>
        <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading the resource…</span><Skeleton variant="panel" /></div>
      </ResourceFrame>
    );
  }

  const list = [...(revisions.data ?? [])].sort((a, b) => b.revision - a.revision);
  const revisionFailure = revisions.status === 'error' ? classifyAuthError(revisions.error) : null;

  return (
    <ResourceFrame organization={organization} project={project} section="library" trail={trail}>
      <header className="proj-title-row">
        <div className="proj-title">
          <span><Chip tone="accent">{resourceKindLabel(resource.kind)}</Chip></span>
          <h1>{resource.name}</h1>
          <p>{resource.description || `Project view of the library item ${resource.name}.`}</p>
          <span className="lib-meta"><code>{resource.slug}</code>{revisions.status === 'ready' && ` · ${plural(list.length, 'revision')}`}</span>
        </div>
        <div className="proj-actions">
          <Action to={`/app/${slug}/library/${encodeURIComponent(resource.id)}`} variant="secondary">Open in library</Action>
          {access.canCreate && <Action variant="secondary" onClick={() => setDetails(true)}>Edit details</Action>}
          {access.canCreate && !editing && <Action variant="primary" onClick={() => { setToast(''); setEditing(true); }} disabled={revisions.status !== 'ready'}>New revision</Action>}
          {access.canAdminister && <Action variant="danger-outline" onClick={() => setRemoving(true)}>Delete</Action>}
        </div>
      </header>

      {!access.canCreate && <ReadOnlyNote role={access.role}>You can read every revision; adding one needs MEMBER.</ReadOnlyNote>}
      {toast && <div className="org-toast" role="status"><CheckCircle2 aria-hidden="true" /><span>{toast}</span></div>}

      {revisions.status === 'loading' && <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading revisions…</span><Skeleton variant="tile" /><Skeleton variant="tile" /></div>}
      {revisionFailure && (
        <Notice tone={revisionFailure.status === 403 ? 'warning' : 'error'} action={revisionFailure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={revisions.reload}>Retry</Action>}>
          {revisionFailure.status === 409
            ? `The stored content of a revision can’t be read${marker(revisionFailure)}.`
            : `The revisions couldn’t be loaded${marker(revisionFailure)}.`}
        </Notice>
      )}
      {revisions.status === 'ready' && list.length === 0 && (
        <section className="lib-dashed lib-nothing" aria-labelledby="rd-empty">
          <strong id="rd-empty">No revisions yet</strong>
          <span>{access.canCreate ? 'Add the first revision to give this resource content.' : 'A member can add the first revision.'}</span>
        </section>
      )}
      {list.length > 0 && (
        <ol className="res-revisions" aria-label="Revisions">
          {list.map((revision) => <RevisionItem key={revision.id} revision={revision} kind={resource.kind} latest={revision.id === list[0].id} />)}
        </ol>
      )}

      {editing && revisions.status === 'ready' && (
        <RevisionEditor
          resource={resource}
          revisions={list}
          organization={organization}
          project={project}
          onCancel={() => setEditing(false)}
          onSaved={(saved, previous) => {
            setEditing(false);
            setToast(saved.revision > previous ? `Revision ${saved.revision} saved and sealed.` : `That content is already revision ${saved.revision}; nothing new was added.`);
            revisions.reload();
          }}
        />
      )}
      <p className="lib-footnote">Each revision is a sealed library version: its fingerprint covers exactly what it holds.</p>

      {details && (
        <EditResourceDialog
          organization={organization}
          project={project}
          resource={resource}
          onClose={() => setDetails(false)}
          onSaved={() => { setDetails(false); setToast('Details saved.'); found.reload(); }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${resource.name}?`}
          confirmLabel="Delete resource"
          onClose={() => setRemoving(false)}
          run={() => platformApi.deleteResource(slug, project.slug, resource.slug)}
          refusal={(caught) => resourceDeleteRefusal(caught).text}
          onDone={() => { setRemoving(false); void navigate(`${root}/resources`, { state: { toast: `“${resource.name}” deleted from this project. Library versions stay.` } }); }}
        >
          <p>The resource leaves {project.name}. Its versions stay in the library, and anything that already pinned one keeps working.</p>
        </ConfirmDialog>
      )}
    </ResourceFrame>
  );
}

/** One project resource (`proj-resource-detail`, `/app/:org/:project/resources/:resource`): what it is, its sealed revisions and the way to add one. */
export function ProjResourceDetail() {
  const { resource: resourceSlug = '' } = useParams();
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <Body key={resourceSlug} organization={organization} project={project} access={access} resourceSlug={resourceSlug} />;
}
