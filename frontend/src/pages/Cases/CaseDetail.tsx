import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { casesApi } from '../../api/cases';
import type { BindingCase, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { formatDate } from '../../utils/format';
import { useResource, type Resource } from '../../utils/useResource';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { isMissing, marker, updateRefusal } from './caseErrors';
import {
  changesBetween, describeChange, DESCRIPTION_MAX, exactReference, glance, plural, refLabel, resourceUses, roleLabel,
} from './casesModel';
import { DeleteCaseDialog } from './dialogs';
import { loadModel, type ModelState } from './modelLoader';
import { CaseFrame, CaseMissing, FlowDrawing, Power, ReadOnlyNote } from './parts';
import { useRouteCase, type RouteCaseContent } from './useRouteCase';
// The timeline styles keep the name of the page that used to hold them.
import '../Platform/CaseDetailPage.css';

function Description({ organization, project, item, canEdit, onSaved }: {
  organization: Organization; project: Project; item: BindingCase; canEdit: boolean; onSaved: () => void;
}) {
  // The saved text is kept here: the case itself is not read again just to show a sentence that was typed a second ago.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const text = saved ?? item.description;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await casesApi.updateCase(organization.slug, project.slug, item.slug, { description: draft.trim() });
      setSaved(updated.description);
      setEditing(false);
      onSaved();
    } catch (caught) {
      setError(updateRefusal(caught).text);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form className="case-description-form" onSubmit={(event) => void save(event)} noValidate>
        <div className="ui-field">
          <label htmlFor="case-description" className="sr-only">Description</label>
          <textarea id="case-description" className="proj-textarea" rows={2} maxLength={DESCRIPTION_MAX} value={draft} onChange={(event) => { setDraft(event.target.value); setError(undefined); }} />
        </div>
        {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        <span className="proj-buttons">
          <Action type="submit" variant="primary" size="sm" busy={busy}>Save</Action>
          <Action variant="secondary" size="sm" onClick={() => { setEditing(false); setError(undefined); }} disabled={busy}>Cancel</Action>
        </span>
      </form>
    );
  }
  return (
    <p className="case-description">
      {text || <span className="org-muted">No description.</span>}
      {canEdit && <button type="button" className="case-link-button" onClick={() => { setDraft(text); setEditing(true); }}>Edit description</button>}
    </p>
  );
}

function RevisionCard({ root, caseSlug, revision, previous, latest, model, publicRead }: {
  root: string; caseSlug: string; revision: RouteCaseContent['revisions'][number]; previous: RouteCaseContent['revisions'][number] | undefined; latest: boolean; model: ModelState | undefined;
  /** A visitor of a public project reads the revision; running it, studying it and collecting it are for members. */
  publicRead: boolean;
}) {
  const { copy, status } = useCopy();
  const uses = resourceUses(revision.document);
  const before = previous ? resourceUses(previous.document) : [];
  const changes = previous ? changesBetween(before, uses) : [];
  const changed = new Set(changes.filter((change) => change.to !== null).map((change) => change.label));
  const summary = !previous
    ? 'First revision.'
    : uses.length === 0 && before.length === 0
      ? 'Its inputs aren’t recorded as library versions.'
      : changes.length === 0 ? `Same library versions as r${previous.revision}.` : changes.map(describeChange).join(' · ');
  const href = `${root}/cases/${caseSlug}/revisions/${revision.revision}`;
  const key = `r${revision.revision}`;
  const log10 = model?.state === 'ready' ? model.model?.log10 ?? null : null;

  return (
    <li className="case-rev">
      <span className={`case-rev-dot${latest ? ' is-latest' : ''}`} aria-hidden="true">r{revision.revision}</span>
      <div className="case-rev-card">
        <div className="case-rev-head">
          <Link to={href} viewTransition><strong>Revision {revision.revision}</strong></Link>
          {latest && <Chip tone="accent">Latest</Chip>}
          <span className="case-rev-date">{formatDate(revision.created_at) ?? '—'}</span>
          <code title={revision.digest}>{shortDigest(revision.digest)}</code>
          <button type="button" className="case-link-button" onClick={() => void copy(exactReference(caseSlug, revision), key)} aria-label={`Copy exact reference of revision ${revision.revision}`}>
            {status(key) === 'copied' ? 'Copied' : status(key) === 'failed' ? 'Copy failed' : 'Copy reference'}
          </button>
        </div>
        <p className="case-rev-change">{summary}</p>
        {uses.length > 0 && (
          <ul className="case-uses" aria-label={`Library versions of revision ${revision.revision}`}>
            {uses.map((use) => (
              <li key={`${use.role}/${use.alias}`} className={changed.has(`${roleLabel(use.role)} · ${use.alias}`) ? 'is-changed' : undefined}>
                <span>{roleLabel(use.role)}</span> <b>{refLabel(use.ref)}</b>
              </li>
            ))}
          </ul>
        )}
        {log10 !== null && (
          <div className="case-rev-size">
            Combinations
            <span className="case-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round((log10 / 20) * 100))}%` }} /></span>
            <span>≈ <Power log10={log10} /></span>
          </div>
        )}
        <div className="case-rev-links">
          <Link to={href} viewTransition>Open</Link>
          {!publicRead && <Link to={`${root}/jobs/new?case=${encodeURIComponent(caseSlug)}&revision=${revision.revision}`} viewTransition>Run</Link>}
          {!publicRead && <Link to={`${root}/studies/new?case=${encodeURIComponent(caseSlug)}&revision=${revision.revision}`} viewTransition>Add to study</Link>}
          {!publicRead && <Link to={`${root}/collections`} viewTransition>Add to collection</Link>}
          {revision.source_snapshot_id && <Link to={`${root}/snapshots/${revision.source_snapshot_id}`} viewTransition>Compiled snapshot</Link>}
        </div>
      </div>
    </li>
  );
}

function GlanceSection({ root, caseSlug, latestNumber, state, reload }: {
  root: string; caseSlug: string; latestNumber: number; state: Resource<ModelState>; reload: () => void;
}) {
  const data = state.data;
  return (
    <section className="org-section" aria-labelledby="cd-glance">
      <h2 id="cd-glance">Latest revision at a glance</h2>
      {state.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Reading the latest revision…</span><Skeleton variant="panel" /></div>}
      {data?.state === 'none' && (
        <p className="org-muted">Revision {latestNumber} has no compiled snapshot, so there is no workflow to draw. Save a new revision from the workbench to get one.</p>
      )}
      {data?.state === 'failed' && (
        <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>
          The model of revision {latestNumber} couldn’t be read{marker(data.failure)}. The revisions above are unaffected.
        </Notice>
      )}
      {data?.state === 'ready' && !data.model && <p className="org-muted">The compiled form of revision {latestNumber} isn’t a binding problem this page can draw.</p>}
      {data?.state === 'ready' && data.model && (
        <>
          <div className="proj-panel">
            <div className="case-flow-head"><b>Workflow</b><span>· {data.model.profile ? `profile ${data.model.profile}` : 'profile not stated'}</span></div>
            <FlowDrawing flow={data.model.flow} caption={<span>Possible combinations ≈ <Power log10={data.model.log10} /></span>} />
          </div>
          <ul className="case-glance" aria-label="Latest revision figures">
            {glance(data.model).map((figure) => <li key={figure.label}><b>{figure.value}</b><span>{figure.label}</span></li>)}
          </ul>
          <Link to={`${root}/cases/${caseSlug}/revisions/${latestNumber}`} viewTransition>See the full revision</Link>
        </>
      )}
    </section>
  );
}

// [impl->req~frontend-retire-composer-entry-points-repointed~1]
function DetailBody({ organization, project, content, canCreate, canAdminister, role }: {
  organization: Organization; project: Project; content: RouteCaseContent; canCreate: boolean; canAdminister: boolean; role: Organization['effective_role'];
}) {
  const navigate = useNavigate();
  const { item, revisions } = content;
  const root = `/app/${organization.slug}/${project.slug}`;
  const publicRead = project.access === 'public_read';
  const latest = revisions[0];
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState('');
  const glanceState = useResource<ModelState>(`glance:${latest?.source_snapshot_id ?? 'none'}`, () => loadModel(latest?.source_snapshot_id ?? null));

  return (
    <CaseFrame organization={organization} project={project} trail={[{ label: 'Cases', to: `${root}/cases` }, { label: item.name }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>{item.name}</h1>
          <div className="proj-title-line"><code className="case-slug">{item.slug}</code><Chip tone={latest ? 'success' : 'plain'}>{plural(revisions.length, 'revision')}</Chip></div>
          <Description organization={organization} project={project} item={item} canEdit={canCreate} onSaved={() => setToast('Description saved.')} />
        </div>
        <div className="proj-actions">
          {canCreate && <Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="primary">New revision</Action>}
          {revisions.length >= 2
            ? <Action to={`${root}/cases/${item.slug}/compare`} variant="secondary">Compare revisions</Action>
            : <span className="ui-action is-secondary is-md" aria-disabled="true" title="Comparing needs two revisions">Compare revisions</span>}
          {latest && !publicRead && <Action to={`${root}/jobs/new?case=${encodeURIComponent(item.slug)}&revision=${latest.revision}`} variant="secondary">Run latest</Action>}
          {latest && <Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}&revision=${latest.id}`} variant="secondary">Open in Workbench</Action>}
          {canAdminister && <Action variant="danger-outline" onClick={() => setDeleting(true)}>Delete case</Action>}
        </div>
      </header>

      {toast && (
        <div className="org-toast" role="status"><CheckCircle2 aria-hidden="true" /><span>{toast}</span></div>
      )}
      {!canCreate && <ReadOnlyNote role={role}>You can read and compare revisions. New revisions need MEMBER; deleting needs ADMIN.</ReadOnlyNote>}

      {revisions.length === 0 ? (
        <section className="case-guide" aria-labelledby="cd-empty">
          <h2 id="cd-empty">No revisions yet</h2>
          <p>A revision pins exact versions of an application, candidate catalog, rules and goal. Compose the first one to be able to run this case.</p>
          {canCreate && <div className="proj-actions"><Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="primary">Compose the first revision</Action></div>}
        </section>
      ) : (
        <>
          <section className="org-section" aria-labelledby="cd-revisions">
            <h2 id="cd-revisions">Revisions</h2>
            <ol className="case-timeline">
              {revisions.map((revision, index) => (
                <RevisionCard
                  key={revision.id}
                  root={root}
                  caseSlug={item.slug}
                  revision={revision}
                  previous={revisions[index + 1]}
                  latest={index === 0}
                  model={index === 0 ? glanceState.data : undefined}
                  publicRead={publicRead}
                />
              ))}
            </ol>
            <span className="org-muted">Changed library versions are highlighted. The API doesn’t say which revision a job ran, so no “used by” list is shown.</span>
          </section>
          <GlanceSection root={root} caseSlug={item.slug} latestNumber={latest.revision} state={glanceState} reload={glanceState.reload} />
        </>
      )}

      {deleting && (
        <DeleteCaseDialog
          organization={organization}
          project={project}
          item={item}
          sealed={revisions.length}
          onClose={() => setDeleting(false)}
          onDeleted={(name) => navigate(`${root}/cases`, { state: { toast: `Case “${name}” deleted.` } })}
        />
      )}
    </CaseFrame>
  );
}

/** A case (`case-detail`, `/app/:org/:project/cases/:case`): its description, its revisions as a timeline and the latest one at a glance. */
export function CaseDetail() {
  const route = useRouteCase();
  const { orgSlug, projectSlug, caseSlug, organization, project, access, waiting, failure, reload, content, loaded, caseFailure } = route;
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  const root = `/app/${organization.slug}/${project.slug}`;
  const trail = [{ label: 'Cases', to: `${root}/cases` }, { label: caseSlug }];

  if (content.status === 'loading' && !loaded) {
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the case…</span><Skeleton variant="panel" /><Skeleton variant="card" /></div>
      </CaseFrame>
    );
  }
  if (caseFailure || !loaded) {
    const missing = isMissing(caseFailure);
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <CaseMissing
          title={missing ? `No case with this address in ${project.name} (404)` : `The case couldn’t be loaded${caseFailure ? marker(caseFailure) : ''}`}
          actions={(
            <>
              <Action to={`${root}/cases`} variant="primary">All cases</Action>
              <Action variant="secondary" onClick={content.reload}>Retry</Action>
            </>
          )}
        >
          {missing ? 'It may have been deleted or renamed.' : 'The gateway didn’t answer for this case. This says nothing about your access. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  return (
    <DetailBody
      organization={organization}
      project={project}
      content={loaded}
      canCreate={access.canCreate}
      canAdminister={access.canAdminister}
      role={access.role}
    />
  );
}
