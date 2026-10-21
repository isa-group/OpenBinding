import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Lock, TriangleAlert } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Organization, Project, Visibility } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { Gate, RoleChip } from '../Organization/parts';
import { RoomBars } from '../Organization/room';
import { roomFromUsage } from '../Organization/roomModel';
import { loadCases, loadReports, loadStudies } from './projectData';
import { deleteRefusal, updateRefusal, type ProjectRefusal } from './projectErrors';
import { countWord, DESCRIPTION_MAX, integrityOf, NAME_MAX, visibilityEffects, visibilityLabel } from './projectModel';
import { canOpenSection } from './accessLevel';
import { MembersOnlyGate, ProjectFrame, ProjectGate, ProjectSkeleton } from './parts';
import { useRouteProject } from './useRouteProject';
import './Project.css';

const VISIBILITIES: readonly Visibility[] = ['private', 'public'];

function DeleteDialog({ organization, project, onClose, onDeleted }: {
  organization: Organization; project: Project; onClose: () => void; onDeleted: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const matches = typed === project.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.deleteProject(organization.slug, project.slug);
      await onDeleted();
    } catch (caught) {
      setError(deleteRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${project.name}?`} tone="danger" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={submit} noValidate>
        <p>This removes its cases, runs, studies and drafts from {organization.name}. It is refused (409) if anything inside has sealed history. This can’t be undone.</p>
        <FormField
          label={`Type ${project.slug} to confirm`}
          value={typed}
          onChange={(event) => { setTyped(event.target.value); setError(undefined); }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <div aria-live="assertive">
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="danger" disabled={!matches} busy={busy}>Delete permanently</Action>
        </div>
      </form>
    </Modal>
  );
}

function SettingsBody({ organization, project, canEdit, reloadProject, reloadWorkspace }: {
  organization: Organization; project: Project; canEdit: boolean; reloadProject: () => void; reloadWorkspace: () => Promise<void>;
}) {
  const { user, isAdmin } = useAuth();
  const org = organization.slug;
  const role = organization.effective_role ?? (isAdmin ? 'PLATFORM ADMIN' as const : null);
  const sponsorIsMe = user?.id === organization.billing_sponsor_user_id;

  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState<string | null>(null);
  const [draftVisibility, setDraftVisibility] = useState<Visibility | null>(null);
  const [busy, setBusy] = useState<'details' | 'visibility' | null>(null);
  const [toast, setToast] = useState('');
  const [errors, setErrors] = useState<{ details?: ProjectRefusal; visibility?: ProjectRefusal }>({});
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const history = useResource(`settings-history:${org}/${project.slug}`, async () => {
    try {
      const [cases, studies, reports] = await Promise.all([loadCases(org, project.slug), loadStudies(org, project.slug), loadReports(org, project.slug)]);
      return { items: integrityOf({ cases, studies, reports: reports.reports }).filter((item) => item.kind === 'sealed'), published: reports.publications.filter((item) => !item.withdrawn).length };
    } catch {
      return null;
    }
  });
  const usage = useResource(`settings-usage:${org}:${sponsorIsMe}`, () => (sponsorIsMe ? apiClient.getOwnUsage().catch(() => null) : Promise.resolve(null)));

  const name = draftName ?? project.name;
  const description = draftDescription ?? project.description;
  const visibility = draftVisibility ?? project.visibility;
  const detailsUnchanged = (name.trim() === project.name && description.trim() === project.description) || !name.trim();
  const visibilityUnchanged = visibility === project.visibility;
  const toPrivate = visibility === 'private' && project.visibility === 'public';
  const effects = visibilityEffects(visibility);
  const room = toPrivate && usage.data ? roomFromUsage(usage.data, ['privateProjects'], { privateProjects: 1 }) : [];

  const sealedItems = history.data?.items ?? [];
  const sealed = sealedItems.length > 0;
  const sealedList = sealedItems.map((item) => `${item.count} ${countWord(item)}`).join(', ');

  const finish = async (text: string) => {
    await reloadWorkspace();
    reloadProject();
    setToast(text);
    setErrors({});
  };

  const saveDetails = async (event: FormEvent) => {
    event.preventDefault();
    if (detailsUnchanged || busy) return;
    setBusy('details');
    setToast('');
    setErrors({});
    try {
      await platformApi.updateProject(org, project.slug, {
        ...(name.trim() !== project.name ? { name: name.trim() } : {}),
        ...(description.trim() !== project.description ? { description: description.trim() } : {}),
      });
      setDraftName(null);
      setDraftDescription(null);
      await finish('Saved. An audit entry was recorded.');
    } catch (caught) {
      setErrors({ details: updateRefusal(caught, 'details') });
    } finally {
      setBusy(null);
    }
  };

  const saveVisibility = async () => {
    if (visibilityUnchanged || busy) return;
    setBusy('visibility');
    setToast('');
    setErrors({});
    try {
      await platformApi.updateProject(org, project.slug, { visibility });
      setDraftVisibility(null);
      await finish(`Visibility changed to ${visibilityLabel(visibility).toLowerCase()}. An audit entry was recorded.`);
    } catch (caught) {
      setErrors({ visibility: updateRefusal(caught, 'visibility') });
    } finally {
      setBusy(null);
    }
  };

  if (deleted) {
    return (
      <div className="proj-body is-md">
        <Gate title={`${project.name} was deleted`} action={<Action to={`/app/${org}`} variant="primary">Back to {organization.name}</Action>}>
          Its cases, runs, studies and drafts are gone. The deletion is recorded in the audit log.
        </Gate>
      </div>
    );
  }

  return (
    <ProjectFrame organization={organization} project={project} section="settings" crumb="Settings" width="md">
      <header className="org-head">
        <div>
          <h1>Project settings</h1>
          <p>{project.name} · your role <RoleChip role={role} /></p>
        </div>
      </header>

      {!canEdit && (
        <Notice tone="info">
          <Lock aria-hidden="true" className="org-inline-icon" /> You’re {role ? <>a <strong>{role}</strong></> : 'not a member'}, so this page is read-only.
          Editing and deleting a project need ADMIN in {organization.name}.
        </Notice>
      )}

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
          {canEdit && <Link to={`/app/${org}/settings/audit`}>Audit log</Link>}
        </div>
      )}

      <section className="org-section" aria-labelledby="ps-general">
        <h2 id="ps-general">General</h2>
        <form className="org-card org-stack" onSubmit={(event) => void saveDetails(event)} noValidate>
          <FormField
            label="Name"
            value={name}
            onChange={(event) => { setDraftName(event.target.value); setErrors({}); }}
            disabled={!canEdit}
            maxLength={NAME_MAX}
          />
          <div className="ui-field">
            <label htmlFor="ps-description">Description</label>
            <textarea
              id="ps-description"
              className="proj-textarea"
              value={description}
              onChange={(event) => { setDraftDescription(event.target.value); setErrors({}); }}
              disabled={!canEdit}
              maxLength={DESCRIPTION_MAX}
              rows={3}
            />
          </div>
          <div className="ui-field">
            <span className="org-fixed-label">Address (fixed)</span>
            <span className="org-fixed">/app/{org}/{project.slug}</span>
          </div>
          {errors.details && <Notice tone="error">{errors.details.text}</Notice>}
          {canEdit && <Action type="submit" variant="primary" disabled={detailsUnchanged} busy={busy === 'details'}>Save</Action>}
        </form>
      </section>

      <section className="org-section" aria-labelledby="ps-visibility">
        <h2 id="ps-visibility">Visibility</h2>
        <div className="org-card org-stack">
          <fieldset className="proj-seg" disabled={!canEdit}>
            <legend className="sr-only">Visibility</legend>
            {VISIBILITIES.map((value) => (
              <label key={value} className={visibility === value ? 'is-checked' : undefined}>
                <input type="radio" name="project-visibility" value={value} checked={visibility === value} onChange={() => { setDraftVisibility(value); setErrors({}); }} />
                {visibilityLabel(value)}
              </label>
            ))}
          </fieldset>
          <div className="proj-effects">
            <div className="is-changes">
              <b>Changes</b>
              <ul>{effects.changes.map((item) => <li key={item}><span aria-hidden="true">✓</span> {item}</li>)}</ul>
            </div>
            <div className="is-stays">
              <b>Doesn’t change</b>
              <ul>{effects.stays.map((item) => <li key={item}><span aria-hidden="true">–</span> {item}</li>)}</ul>
            </div>
          </div>
          {toPrivate && (room.length > 0
            ? <div><RoomBars rows={room} /><span className="org-muted">The sponsor’s plan limit. This project counts as private once you change it.</span></div>
            : <span className="org-muted">The sponsor’s private-project count is checked when you change it; if there’s no room the answer is 402.</span>)}
          {errors.visibility && (
            <Notice tone="error">
              <span>{errors.visibility.text}</span>
              {errors.visibility.kind === 'quota' && <span className="org-notice-links"><Link to="/app/account/usage">Your plan</Link></span>}
            </Notice>
          )}
          {canEdit && <Action variant="secondary" onClick={() => void saveVisibility()} disabled={visibilityUnchanged} busy={busy === 'visibility'}>Change visibility</Action>}
        </div>
      </section>

      <section className="org-section" aria-labelledby="ps-danger">
        <h2 id="ps-danger">Danger zone</h2>
        <div className="org-card is-danger org-stack">
          <strong>Delete this project</strong>
          {sealed && (
            <div className="proj-note is-warning" role="note">
              <Lock aria-hidden="true" className="org-inline-icon" />
              <span>
                Deleting is blocked: this project has sealed history ({sealedList}){history.data && history.data.published > 0 ? `, including ${history.data.published} published ${history.data.published === 1 ? 'report' : 'reports'}` : ''}.
                Sealed history must stay reachable so people can still verify it.
              </span>
            </div>
          )}
          <span className="org-muted">Removes its cases, runs, studies and drafts. This can’t be undone.</span>
          {history.status === 'loading' && canEdit && <Skeleton variant="tile" />}
          {canEdit && <Action variant="danger-outline" onClick={() => setDeleting(true)} disabled={sealed} className="org-danger-button">Delete project</Action>}
        </div>
      </section>

      {deleting && (
        <DeleteDialog
          organization={organization}
          project={project}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            await reloadWorkspace();
            setDeleting(false);
            setDeleted(true);
          }}
        />
      )}
    </ProjectFrame>
  );
}

/** Project settings (`proj-settings`, `/app/:org/:project/settings`): name, description, visibility and deletion. */
export function ProjectSettings() {
  const { context, orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  if (!canOpenSection(access.level, 'settings')) return <MembersOnlyGate root={`/app/${organization.slug}/${project.slug}`} />;
  return <SettingsBody organization={organization} project={project} canEdit={access.canAdminister} reloadProject={reload} reloadWorkspace={context.reload} />;
}
