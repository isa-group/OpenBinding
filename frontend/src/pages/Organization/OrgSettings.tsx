import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircle2, Lock, TriangleAlert } from 'lucide-react';
import { isSponsorProposal, type SponsorProposal } from '../../api/auth';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { ancestorsOf, atLeast, descendantsOf, initialsOf, pathOf, sponsorName } from './orgModel';
import { classifyAuthError, generalFailure, marker, type AuthFailure } from './orgErrors';
import { Choice, NeutralGate, PageSkeleton, RoleChip, SelectField } from './parts';
import { OrgSettingsLayout } from './OrgSettingsLayout';
import { SponsorProposalList, SponsorRequestCard } from './SponsorCards';
import { canCancelProposal, pendingOf, proposedName, sponsorRefusal } from './sponsorModel';
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
  const { user, isAdmin: platformAdmin } = useAuth();
  const navigate = useNavigate();
  const slug = organization.slug;
  const role = organization.effective_role;
  const canEdit = atLeast(role, 'ADMIN');
  const canSponsor = atLeast(role, 'OWNER');
  const me = user ? { id: user.id, username: user.username } : null;

  const parent = ancestorsOf(organization, context.organizations)[0];
  const people = useResource(`settings-people:${slug}`, () => platformApi.members(slug).catch(() => null));
  const parentPeople = useResource(`settings-parent-people:${parent?.slug ?? ''}`, () => (parent ? platformApi.members(parent.slug).catch(() => null) : Promise.resolve(null)));
  const projects = useResource(`settings-projects:${slug}`, () => platformApi.projects(slug).catch(() => null));
  const accounts = useResource(`settings-accounts:${platformAdmin && canSponsor}`, () => (platformAdmin && canSponsor ? apiClient.adminListUsers({ limit: 100 }).catch(() => null) : Promise.resolve(null)));
  // The requests made for this organization (OWNER and ADMIN read them); `null` when they can't be read.
  const requests = useResource<SponsorProposal[] | null>(`settings-sponsor-requests:${slug}:${canEdit}`, async () => {
    if (!canEdit) return null;
    try {
      return await apiClient.listOrganizationSponsorProposals(slug);
    } catch {
      return null;
    }
  });

  const [draftName, setDraftName] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [sponsorKey, setSponsorKey] = useState('');
  const [busy, setBusy] = useState<'name' | 'move' | 'sponsor' | 'cancel' | null>(null);
  const [toast, setToast] = useState('');
  const [errors, setErrors] = useState<{ name?: string; move?: string; sponsor?: string }>({});
  const [deleting, setDeleting] = useState(false);
  /** The request just sent, shown at once while the list is read again. */
  const [sent, setSent] = useState<SponsorProposal | null>(null);
  /** A request was already waiting when somebody else was named: the person who was being named, so the sender can replace it. */
  const [replacing, setReplacing] = useState<{ userId: string } | null>(null);

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

  // --- who sponsors it
  const sponsorOptions: Array<{ key: string; userId: string; label: string }> = [];
  if (me && organization.billing_sponsor_user_id !== me.id) sponsorOptions.push({ key: 'self', userId: me.id, label: `Me (${me.username})` });
  if (parent && parent.billing_sponsor_user_id !== organization.billing_sponsor_user_id && parent.billing_sponsor_user_id !== me?.id) {
    sponsorOptions.push({ key: 'parent', userId: parent.billing_sponsor_user_id, label: `${sponsorName(parent, parentPeople.data ?? [], me)} · parent’s sponsor` });
  }
  for (const account of accounts.data?.users ?? []) {
    if (account.id === organization.billing_sponsor_user_id || sponsorOptions.some((option) => option.userId === account.id)) continue;
    sponsorOptions.push({ key: `user:${account.id}`, userId: account.id, label: `${account.username} · ${account.plan} (administrator choice)` });
  }
  const chosenSponsor = sponsorOptions.find((option) => option.key === sponsorKey);
  // Naming yourself changes the sponsor at once; naming anybody else only sends them a request.
  const choosesOther = Boolean(chosenSponsor && chosenSponsor.userId !== me?.id);
  const open = pendingOf(requests.data) ?? (sent && sent.status === 'pending' ? sent : null);
  const canCancel = Boolean(open && canCancelProposal(open, { userId: me?.id, owner: canSponsor, platformAdmin }));
  const iSentIt = Boolean(open && me && open.proposed_by_user_id === me.id);

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

  /** Name a sponsor: yourself changes it now (200); anybody else gets a request (202) and the sponsor stays as it is. */
  const sendSponsor = async (userId: string, replace: boolean) => {
    setBusy('sponsor');
    setToast('');
    setErrors({});
    try {
      const result = await platformApi.updateOrganization(slug, { billing_sponsor_user_id: userId, ...(replace ? { replace_pending_proposal: true } : {}) });
      setSponsorKey('');
      setReplacing(null);
      if (isSponsorProposal(result)) {
        setSent(result);
        flash(`Sponsor request sent to ${proposedName(result)}. Nothing changes until they accept.`);
      } else {
        setSent(null);
        await context.reload();
        flash('Sponsor changed. Size limits now come from the new sponsor’s plan.');
      }
      requests.reload();
    } catch (caught) {
      const refusal = sponsorRefusal(caught, 'propose');
      if (refusal.code === 'sponsor_proposal_pending') {
        // Who sent the waiting request decides whether it can be replaced: read the list again to know.
        setReplacing({ userId });
        requests.reload();
      }
      setErrors({ sponsor: refusal.text });
    } finally {
      setBusy(null);
    }
  };

  const cancelRequest = async (proposal: SponsorProposal) => {
    setBusy('cancel');
    setToast('');
    setErrors({});
    try {
      await apiClient.cancelSponsorProposal(proposal.id);
      setSent(null);
      setReplacing(null);
      flash('Sponsor request cancelled. The sponsor stays as it was.');
      requests.reload();
    } catch (caught) {
      setErrors({ sponsor: sponsorRefusal(caught, 'cancel').text });
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

  const changeSponsor = () => {
    if (!chosenSponsor) return;
    void sendSponsor(chosenSponsor.userId, false);
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
            The sponsor’s plan sets this organization’s size limits. Sponsoring gives no role or access. Only an OWNER can change it, and nobody can make
            another person pay: naming someone else sends them a request, and the sponsor changes when they accept.
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
          {canSponsor && (
            <>
              <SelectField label="New sponsor" value={sponsorKey} onChange={(value) => { setSponsorKey(value); setErrors({}); setReplacing(null); }} maxWidth="420px">
                <option value="">Keep {sponsor}</option>
                {sponsorOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </SelectField>
              <span className="org-muted">
                {!chosenSponsor && 'Pick a new sponsor to see what changes.'}
                {chosenSponsor && !choosesOther && 'The new sponsor’s limits are checked first. If this organization’s projects and members don’t fit, nothing changes.'}
                {chosenSponsor && choosesOther && 'This sends them a request. Nothing changes until they accept; then this organization and everything under it count against their plan and its limits.'}
              </span>
              <Action variant="secondary" onClick={changeSponsor} disabled={!chosenSponsor} busy={busy === 'sponsor'}>
                {choosesOther ? 'Send sponsor request' : 'Change sponsor'}
              </Action>
            </>
          )}
          {!canSponsor && <span className="org-muted">Needs OWNER. Your role here is {role}.</span>}
          {errors.sponsor && <Notice tone="error">{errors.sponsor}</Notice>}
          {accounts.status === 'loading' && platformAdmin && canSponsor && <Skeleton variant="tile" />}
        </div>
        {open && (
          <SponsorRequestCard
            proposal={open}
            cancel={canCancel ? { busy: busy === 'cancel', onCancel: () => void cancelRequest(open) } : undefined}
            replace={replacing && iSentIt ? { busy: busy === 'sponsor', onReplace: () => void sendSponsor(replacing.userId, true) } : undefined}
          >
            {replacing && !iSentIt && canSponsor && (
              <span className="org-muted">Someone else sent this request. Cancel it first, then send yours.</span>
            )}
          </SponsorRequestCard>
        )}
      </section>

      {canEdit && (
        <section className="org-section" aria-labelledby="os-requests">
          <div>
            <h2 id="os-requests">Sponsor requests</h2>
            <p className="org-muted">Every request to become this organization’s sponsor. A request lapses after 14 days if nobody answers.</p>
          </div>
          {requests.status === 'loading' && <Skeleton variant="tile" />}
          {requests.status === 'ready' && requests.data === null && (
            <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={requests.reload}>Try again</Action>}>
              The sponsor requests couldn’t be loaded right now.
            </Notice>
          )}
          {requests.data && <SponsorProposalList proposals={requests.data} />}
        </section>
      )}

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
