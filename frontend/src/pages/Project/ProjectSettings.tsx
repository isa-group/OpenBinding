import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CheckCircle2, Lock, TriangleAlert } from 'lucide-react';
import { platformApi } from '../../api/platform';
import type { Organization, Project, Visibility } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { Gate } from '../Organization/parts';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { deleteRefusal, updateRefusal, type ProjectRefusal } from './projectErrors';
import { DESCRIPTION_MAX, NAME_MAX, visibilityEffects, visibilityLabel } from './projectModel';
import { canOpenSection } from './accessLevel';
import { MembersOnlyGate, OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { ProjectMembers } from './ProjectMembers';
import { ProjectSettingsLayout } from './ProjectSettingsLayout';
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
        <p>This removes the project and its memberships from {organization.name}. Problems, runs and studies belong to the organization and stay. This can’t be undone.</p>
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
  const { isAdmin } = useAuth();
  const org = organization.slug;
  const role = organization.effective_role ?? (isAdmin ? 'PLATFORM ADMIN' as const : null);

  const [draftName, setDraftName] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState<string | null>(null);
  const [draftVisibility, setDraftVisibility] = useState<Visibility | null>(null);
  const [busy, setBusy] = useState<'details' | 'visibility' | null>(null);
  const [toast, setToast] = useState('');
  const [errors, setErrors] = useState<{ details?: ProjectRefusal; visibility?: ProjectRefusal }>({});
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  const name = draftName ?? project.name;
  const description = draftDescription ?? project.description;
  const visibility = draftVisibility ?? project.visibility;
  const detailsUnchanged = (name.trim() === project.name && description.trim() === project.description) || !name.trim();
  const visibilityUnchanged = visibility === project.visibility;
  const effects = visibilityEffects(visibility);

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
          The organization keeps its problems, runs and studies. The deletion is recorded in the audit log.
        </Gate>
      </div>
    );
  }

  return (
    <ProjectSettingsLayout organization={organization} project={project} section="general">
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
          {errors.visibility && <Notice tone="error">{errors.visibility.text}</Notice>}
          {canEdit && <Action variant="secondary" onClick={() => void saveVisibility()} disabled={visibilityUnchanged} busy={busy === 'visibility'}>Change visibility</Action>}
        </div>
      </section>

      <section className="org-section" aria-labelledby="ps-danger">
        <h2 id="ps-danger">Danger zone</h2>
        <div className="org-card is-danger org-stack">
          <strong>Delete this project</strong>
          <span className="org-muted">Removes the project and its memberships; the organization keeps its problems, runs and studies. This can’t be undone.</span>
          {canEdit && <Action variant="danger-outline" onClick={() => setDeleting(true)} className="org-danger-button">Delete project</Action>}
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
    </ProjectSettingsLayout>
  );
}

function SettingsPage({ section }: { section: 'general' | 'members' }) {
  const { context, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <OrgSkeleton label="Loading project…" />;
  if (!organization || !project) {
    return <OrgGate failure={organization ? failure : null} organizationName={organization?.name} onRetry={reload} />;
  }
  if (!canOpenSection(access.level, 'settings')) return <MembersOnlyGate root={`/app/${organization.slug}/${project.slug}`} />;
  if (section === 'members') return <ProjectMembers organization={organization} project={project} />;
  return (
    <SettingsBody
      organization={organization}
      project={project}
      canEdit={access.canAdminister}
      reloadProject={reload}
      reloadWorkspace={context.reload}
    />
  );
}

/**
 * Project settings (`proj-settings`, `/app/:org/:project/settings/:section?`): General (name, description, visibility, the package
 * export and import, deletion) and Members (`members`). Any other section is a page that does not exist.
 */
export function ProjectSettings() {
  const { section } = useParams();
  if (section === undefined) return <SettingsPage section="general" />;
  if (section === 'members') return <SettingsPage section="members" />;
  return <NotFoundScreen />;
}
