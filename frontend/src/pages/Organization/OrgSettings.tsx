import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Lock, TriangleAlert } from 'lucide-react';
import { platformApi } from '../../api/platform';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { ancestorsOf, atLeast, descendantsOf, initialsOf, pathOf, sponsorName } from './orgModel';
import { classifyAuthError, generalFailure, marker, type AuthFailure } from './orgErrors';
import { Choice, NeutralGate, PageSkeleton, RoleChip } from './parts';
import { OrgSettingsLayout } from './OrgSettingsLayout';
import { sponsorRefusal } from './sponsorModel';
import { useRouteOrganization } from './useRouteOrganization';
import './Organization.css';

/** The words for each way an update of the organization (rename, move) can be refused; naming a sponsor has its own, in `sponsorModel`. */
function updateRefusal(failure: AuthFailure): string {
  switch (failure.code) {
    case 'organization_cycle':
      return `That move would put the organization inside itself${marker(failure)}. Choose another parent.`;
    case 'ambiguous_parent':
      return `Choose either a new parent or the top level, not both${marker(failure)}.`;
    case 'organization_forbidden':
      return `You need ADMIN here, and in the new parent, for this${marker(failure)}.`;
    case 'pricing_unavailable':
      return `Limits can’t be checked right now${marker(failure)}. Nothing changed.`;
    default:
      if (failure.kind === 'not-found') return `The organization or its new parent no longer exists${marker(failure)}. Reload the page and try again.`;
      if (failure.kind === 'invalid') return `The gateway refused that value${marker(failure)}.${failure.message ? ` ${failure.message}` : ''}`;
      return generalFailure(failure, 'nothing changed');
  }
}

function SettingsBody({ organization }: { organization: Organization }) {
  const { context } = useRouteOrganization();
  const { user } = useAuth();
  const navigate = useNavigate();
  const slug = organization.slug;
  const role = organization.effective_role;
  const canEdit = atLeast(role, 'ADMIN');
  const canSponsor = atLeast(role, 'OWNER');
  const me = user ? { id: user.id, username: user.username } : null;

  const people = useResource(`settings-people:${slug}`, () => platformApi.members(slug).catch(() => null));
  const projects = useResource(`settings-projects:${slug}`, () => platformApi.projects(slug).catch(() => null));

  const [draftName, setDraftName] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'name' | 'move' | 'sponsor' | null>(null);
  const [toast, setToast] = useState('');
  const [errors, setErrors] = useState<{ name?: string; move?: string; sponsor?: string }>({});
  const [deleting, setDeleting] = useState(false);

  const name = draftName ?? organization.name;
  const nameUnchanged = name.trim() === organization.name || !name.trim();
  const sponsor = sponsorName(organization, people.data ?? [], me);
  const sponsorPlan = me && organization.billing_sponsor_user_id === me.id ? user?.plan : undefined;

  // --- where it sits
  const currentParentId = organization.parent_id ?? '';
  const target = moveTo ?? currentParentId;
  const below = descendantsOf(organization, context.organizations);
  const others = context.organizations.filter((item) => item.id !== organization.id);
  const parentVisible = !organization.parent_id || others.some((item) => item.id === organization.parent_id);
  const targetOrg = others.find((item) => item.id === target);
  const previewPath = targetOrg ? pathOf(targetOrg, context.organizations) : [];

  // --- who sponsors it: a user may only name themselves
  const canTakeSponsorship = Boolean(me && organization.billing_sponsor_user_id !== me.id);

  const flash = (text: string) => {
    setToast(text);
    setErrors({});
  };

  const update = async (kind: 'name' | 'move', value: Parameters<typeof platformApi.updateOrganization>[1], done: string) => {
    setBusy(kind);
    setToast('');
    setErrors({});
    try {
      await platformApi.updateOrganization(slug, value);
      await context.reload();
      if (kind === 'name') setDraftName(null);
      if (kind === 'move') setMoveTo(null);
      flash(done);
    } catch (caught) {
      const failure = classifyAuthError(caught);
      const text = kind === 'name' && failure.kind === 'unavailable'
        ? `The name couldn’t be saved right now${marker(failure)}. Try again in a moment.`
        : updateRefusal(failure);
      const next: typeof errors = {};
      next[kind] = text;
      setErrors(next);
    } finally {
      setBusy(null);
    }
  };

  /** Make the caller the sponsor: it changes at once. */
  const takeSponsorship = async () => {
    if (!me) return;
    setBusy('sponsor');
    setToast('');
    setErrors({});
    try {
      await platformApi.updateOrganization(slug, { billing_sponsor_user_id: me.id });
      await context.reload();
      flash('Sponsor changed. Size limits now come from the new sponsor’s plan.');
    } catch (caught) {
      setErrors({ sponsor: sponsorRefusal(caught) });
    } finally {
      setBusy(null);
    }
  };

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    if (nameUnchanged) return;
    const next = name.trim();
    void update('name', { name: next }, `Name saved as “${next}”. An audit entry was recorded.`);
  };

  const move = () => {
    const destination = targetOrg;
    void update(
      'move',
      target ? { parent_id: target } : { move_to_root: true },
      `Moved ${organization.name} ${destination ? `inside ${destination.name}` : 'to the top level'}.`,
    );
  };

  const treeNote = target === currentParentId
    ? 'No change yet.'
    : targetOrg ? `Members of ${targetOrg.name} will inherit their roles here.` : 'Only direct members will have roles here.';

  const impact: Array<{ n: string; l: string }> = [
    { n: projects.data ? String(projects.data.length) : '—', l: 'projects' },
    { n: String(below.length), l: below.length === 1 ? 'sub-organization' : 'sub-organizations' },
    { n: people.data ? String(people.data.length) : '—', l: people.data?.length === 1 ? 'direct member' : 'direct members' },
  ];

  return (
    <OrgSettingsLayout
      organization={organization}
      section="general"
      title="Settings"
      lede={<>{organization.name} · your role <RoleChip role={role} /></>}
    >
      {!canEdit && (
        <Notice tone="info">
          <Lock aria-hidden="true" className="org-inline-icon" /> You’re a <strong>{role}</strong>, so these settings are read-only.
          Renaming, moving and deleting need ADMIN; changing the sponsor needs OWNER. Ask an owner or admin in <Link to={`/app/${slug}/settings/members`}>Members</Link>.
        </Notice>
      )}

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
          {canEdit && <Link to={`/app/${slug}/settings/audit`}>See it in the audit log</Link>}
        </div>
      )}

      <section className="org-section" aria-labelledby="os-general">
        <h2 id="os-general">General</h2>
        <form className="org-card org-form-grid" onSubmit={saveName} noValidate>
          <FormField
            label="Name"
            value={name}
            onChange={(event) => { setDraftName(event.target.value); setErrors({}); }}
            disabled={!canEdit}
            maxLength={160}
            error={errors.name}
          />
          <div className="ui-field">
            <span className="org-fixed-label">Address (fixed)</span>
            <span className="org-fixed">/app/{slug}</span>
          </div>
          {canEdit && (
            <div className="org-form-actions">
              <Action type="submit" variant="primary" disabled={nameUnchanged} busy={busy === 'name'}>Save name</Action>
            </div>
          )}
        </form>
      </section>

      <section className="org-section" aria-labelledby="os-place">
        <div>
          <h2 id="os-place">Place in the hierarchy</h2>
          <p className="org-muted">Moving changes who inherits roles here. You need ADMIN here and in the new parent.</p>
        </div>
        <div className="org-card org-move">
          <div className="org-move-choices">
            <fieldset className="org-choices" disabled={!canEdit}>
              <legend className="sr-only">New parent</legend>
              <Choice
                name="new-parent" value="" checked={target === ''} disabled={!canEdit} onChange={() => { setMoveTo(''); setErrors({}); }}
                label={`Top level${currentParentId === '' ? ' · current' : ''}`}
                sub="No parent; only direct members keep roles"
              />
              {!parentVisible && (
                <Choice
                  name="new-parent" value={organization.parent_id ?? ''} checked={false} disabled onChange={() => undefined}
                  label="Current parent · current" sub="You can’t see it, so you can’t choose it again" warn
                />
              )}
              {others.map((item) => {
                const loop = below.some((descendant) => descendant.id === item.id);
                const allowed = atLeast(item.effective_role, 'ADMIN');
                const unavailable = loop || !allowed;
                return (
                  <Choice
                    key={item.id}
                    name="new-parent"
                    value={item.id}
                    checked={target === item.id}
                    disabled={!canEdit || unavailable}
                    onChange={() => { setMoveTo(item.id); setErrors({}); }}
                    label={`${item.name}${item.id === organization.parent_id ? ' · current' : ''}`}
                    sub={loop ? 'It sits inside this organization: moving here would make a loop' : allowed ? 'You can move it here' : `Needs ADMIN there; you’re ${item.effective_role}`}
                    warn={unavailable}
                  />
                );
              })}
            </fieldset>
            {canEdit && (
              <Action variant="secondary" onClick={move} disabled={target === currentParentId} busy={busy === 'move'}>Move organization</Action>
            )}
            {errors.move && <Notice tone="error">{errors.move}</Notice>}
          </div>
          <div className="org-move-preview">
            <span className="org-eyebrow">After the move</span>
            <ul aria-label="Organization tree after the move">
              {previewPath.map((item, depth) => (
                <li key={item.id} style={{ marginLeft: depth * 20 }}><span className="org-node">{item.name}</span></li>
              ))}
              <li style={{ marginLeft: previewPath.length * 20 }}><span className="org-node is-new">{organization.name}</span></li>
              {below.map((item) => {
                const depth = previewPath.length + 1 + (ancestorsOf(item, context.organizations).findIndex((ancestor) => ancestor.id === organization.id));
                return <li key={item.id} style={{ marginLeft: depth * 20 }}><span className="org-node">{item.name}</span></li>;
              })}
            </ul>
            <span className="org-muted">{treeNote}</span>
          </div>
        </div>
      </section>

      <section className="org-section" aria-labelledby="os-sponsor">
        <div>
          <h2 id="os-sponsor">Sponsor</h2>
          <p className="org-muted">
            The sponsor’s plan sets this organization’s size limits. Sponsoring gives no role or access. Only an OWNER can change it, and only to themselves:
            nobody can make another person pay.
          </p>
        </div>
        <div className="org-card org-stack">
          <div className="org-sponsor">
            <span className="org-avatar" aria-hidden="true">{initialsOf(sponsor.replace(/ \(you\)$/, ''))}</span>
            <span>
              <strong>{sponsor}</strong>
              <small>Current sponsor{sponsorPlan ? ` · ${sponsorPlan} plan` : ''}</small>
            </span>
          </div>
          {canSponsor && canTakeSponsorship && (
            <>
              <span className="org-muted">The new sponsor’s limits are checked first. If this organization’s projects and members don’t fit, nothing changes.</span>
              <Action variant="secondary" onClick={() => void takeSponsorship()} busy={busy === 'sponsor'}>Make me the sponsor</Action>
            </>
          )}
          {!canSponsor && <span className="org-muted">Needs OWNER. Your role here is {role}.</span>}
          {errors.sponsor && <Notice tone="error">{errors.sponsor}</Notice>}
        </div>
      </section>

      <section className="org-section" aria-labelledby="os-danger">
        <h2 id="os-danger">Danger zone</h2>
        <div className="org-card is-danger org-stack">
          <strong>Delete this organization</strong>
          <span className="org-muted">
            Deletes everything inside it, including sub-organizations. An organization with sealed history (published reports,
            study runs, case revisions or library versions) can’t be deleted. This can’t be undone.
          </span>
          <dl className="org-impact" aria-label="What deleting removes">
            {impact.map((item) => <div key={item.l}><dt>{item.l}</dt><dd>{item.n}</dd></div>)}
          </dl>
          {canEdit && <Action variant="danger-outline" onClick={() => setDeleting(true)} className="org-danger-button">Delete organization</Action>}
        </div>
      </section>

      {deleting && (
        <DeleteDialog
          organization={organization}
          summary={`This removes ${projects.data?.length ?? 'its'} project(s) and ${below.length} sub-organization(s). It is refused (409) if anything inside has sealed history.`}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            await context.reload();
            navigate('/app', { state: { deletedOrganization: organization.name } });
          }}
        />
      )}
      {people.status === 'loading' && <span className="sr-only" role="status">Loading members…</span>}
    </OrgSettingsLayout>
  );
}

function DeleteDialog({ organization, summary, onClose, onDeleted }: {
  organization: Organization;
  summary: string;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const matches = typed === organization.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.deleteOrganization(organization.slug);
      await onDeleted();
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.code === 'historical_references') {
        setError(`It has sealed history, so it can’t be deleted${marker(failure)}. ${failure.message ?? ''}`.trim());
      } else if (failure.status === 403) {
        setError(`You need ADMIN here to delete it${marker(failure)}. Nothing was deleted.`);
      } else if (failure.kind === 'not-found') {
        setError(`It no longer exists${marker(failure)}.`);
      } else {
        setError(generalFailure(failure, 'nothing was deleted'));
      }
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${organization.name}?`} tone="danger" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={submit} noValidate>
        <p>{summary}</p>
        <FormField
          label={`Type ${organization.slug} to confirm`}
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

/** Organization settings (`org-settings`, `/app/:org/settings`): name, place, sponsor and deletion. */
export function OrgSettings() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <div className="org-page"><PageSkeleton /></div>;
  if (!organization) return <div className="org-page"><NeutralGate /></div>;
  return <SettingsBody organization={organization} />;
}
