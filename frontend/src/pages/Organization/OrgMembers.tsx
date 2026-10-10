import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, TriangleAlert, UserRoundPlus } from 'lucide-react';
import { apiClient } from '../../api/client';
import { MEMBER_BATCH_LIMIT, platformApi } from '../../api/platform';
import type { MemberChange, Organization, OrganizationInvitation, OrganizationMember, OrganizationRole } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { DataTable } from '../../components/ui/DataTable';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDate, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ancestorsOf, atLeast, higherRole, rankOf, ROLE_SUMMARY, ROLES, sponsorName } from './orgModel';
import { classifyAuthError, generalFailure, isForbidden, marker, quotaOf, type AuthFailure } from './orgErrors';
import { NeutralGate, PageSkeleton, RoleChip, SelectField } from './parts';
import { OrgSettingsLayout } from './OrgSettingsLayout';
import { useRouteOrganization } from './useRouteOrganization';
import './Organization.css';

const NO_DIRECT_ROLE = '__none';

interface Inherited {
  role: OrganizationRole;
  from: Organization;
}

interface Row {
  userId: string;
  name: string;
  email: string | null;
  direct: OrganizationRole | null;
  inherited: Inherited | null;
  addedAt: string | null;
}

interface Snapshot {
  direct: OrganizationMember[];
  /** The direct members of each visible ancestor: the roles that reach this organization from above. */
  above: Array<{ organization: Organization; members: OrganizationMember[] }>;
  /** `null`: the sponsor’s own usage is not visible, or could not be read. */
  seats: { used: number; limit: number } | null;
}

interface PendingInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
}

/** Everyone with a role here, whether it is their own or reaches them from an ancestor. */
function buildRows(direct: OrganizationMember[], above: Snapshot['above']): Row[] {
  const rows = new Map<string, Row>();
  const person = (member: OrganizationMember): Row => rows.get(member.user_id) ?? {
    userId: member.user_id,
    name: member.username ?? member.email ?? member.user_id,
    email: member.email,
    direct: null,
    inherited: null,
    addedAt: null,
  };
  for (const member of direct) {
    rows.set(member.user_id, { ...person(member), direct: member.role, addedAt: member.created_at });
  }
  for (const level of above) {
    for (const member of level.members) {
      const row = person(member);
      if (!row.inherited || rankOf(member.role) > rankOf(row.inherited.role)) {
        rows.set(member.user_id, { ...row, inherited: { role: member.role, from: level.organization } });
      } else {
        rows.set(member.user_id, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => (
    rankOf(higherRole(b.direct, b.inherited?.role)) - rankOf(higherRole(a.direct, a.inherited?.role)) || a.name.localeCompare(b.name)
  ));
}

function effectiveOf(row: Row): { role: OrganizationRole | null; source: string } {
  const { direct, inherited } = row;
  if (direct && inherited) {
    return rankOf(direct) >= rankOf(inherited.role)
      ? { role: direct, source: `Own role (higher than inherited ${inherited.role})` }
      : { role: inherited.role, source: `Inherited from ${inherited.from.name}` };
  }
  if (direct) return { role: direct, source: 'Own role' };
  if (inherited) return { role: inherited.role, source: `Inherited from ${inherited.from.name}` };
  return { role: null, source: '' };
}

/** The words for each way the gateway can refuse a batch. */
function batchRefusal(failure: AuthFailure, quota: ReturnType<typeof quotaOf>): string {
  switch (failure.code) {
    case 'last_owner':
      return `At least one OWNER must remain${marker(failure)}. Keep someone as OWNER, or make another person OWNER in the same batch.`;
    case 'sponsor_quota_exceeded':
      return `The sponsor has no member seats left${marker(failure)}${quota ? `: ${quota.used ?? '?'} of ${quota.limit} used` : ''}. Nothing changed.`;
    case 'member_mismatch':
      return `One of these people isn’t a member of this organization${marker(failure)}. Refresh and try again.`;
    case 'organization_forbidden':
      return `You need ADMIN here to change members${marker(failure)}. Nothing changed.`;
    case 'invalid_sponsor':
      return `The organization’s sponsor isn’t active${marker(failure)}, so members can’t change. Nothing changed.`;
    case 'pricing_unavailable':
      return `Limits can’t be checked right now${marker(failure)}. Nothing changed; try again in a moment.`;
    default:
      if (failure.kind === 'not-found') return `One of these people no longer exists or isn’t a member${marker(failure)}. Refresh and try again; nothing changed.`;
      if (failure.kind === 'invalid') return `The same person appears twice, or a change is malformed${marker(failure)}. Each person can have one change.`;
      return generalFailure(failure, 'nothing changed');
  }
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function InviteDialog({ organization, sponsor, onClose, onInvited }: {
  organization: Organization;
  sponsor: string;
  onClose: () => void;
  onInvited: (invitation: OrganizationInvitation) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrganizationRole>('MEMBER');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OrganizationInvitation | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError('Enter a valid email address (422).');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const invitation = await platformApi.inviteMember(organization.slug, { email: email.trim(), role });
      onInvited(invitation);
      setCreated(invitation);
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'invalid') setError(`Enter a valid email address${marker(failure)}.`);
      else if (isForbidden(failure)) setError(`You need ADMIN here to invite${marker(failure)}.`);
      else setError(generalFailure(failure, 'no invitation was created'));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal title="Invitation created" tone="warning" size="md" dismissible={false} onClose={onClose}>
        <div className="org-dialog-form">
          <Notice tone="warning">
            <strong>Shown only once.</strong> Send this code to {created.email} yourself; it only works for that address and expires
            {' '}{formatDateTime(created.expires_at) ?? 'in seven days'}.
          </Notice>
          <CopyField value={created.token} label="invitation code" />
          <span className="org-muted">
            They paste it on the <Link to="/invitations/accept">accept invitation</Link> page. As {created.role}, they count as a member of {sponsor}’s organizations once they accept.
          </span>
          <div className="ui-modal-actions">
            <Action variant="primary" onClick={onClose} data-autofocus>I’ve saved it</Action>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Invite to ${organization.name}`} size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={submit} noValidate>
        <FormField
          label="Email"
          type="email"
          value={email}
          onChange={(event) => { setEmail(event.target.value); setError(undefined); }}
          autoComplete="off"
          spellCheck={false}
        />
        <SelectField label="Role when they join" value={role} onChange={(value) => setRole(value as OrganizationRole)}>
          {[...ROLES].reverse().map((item) => <option key={item} value={item}>{item} · {ROLE_SUMMARY[item]}</option>)}
        </SelectField>
        <span className="org-muted">The invitation lasts 7 days. They count as a member of {sponsor}’s organizations once they accept.</span>
        <div aria-live="assertive">
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Create invitation</Action>
        </div>
      </form>
    </Modal>
  );
}

function MembersBody({ organization }: { organization: Organization }) {
  const { context } = useRouteOrganization();
  const { user } = useAuth();
  const slug = organization.slug;
  const role = organization.effective_role;
  const canWrite = atLeast(role, 'ADMIN');
  const sponsorIsMe = user?.id === organization.billing_sponsor_user_id;
  const me = user ? { id: user.id, username: user.username } : null;

  const snapshot = useResource<Snapshot>(`members:${slug}`, async () => {
    const above = ancestorsOf(organization, context.organizations);
    const [direct, ...levels] = await Promise.all([
      platformApi.members(slug),
      ...above.map((item) => platformApi.members(item.slug).then((members) => ({ organization: item, members })).catch(() => null)),
    ]);
    let seats: Snapshot['seats'] = null;
    if (sponsorIsMe) {
      const usage = await apiClient.getOwnUsage().catch(() => null);
      const tracked = usage?.limits.members;
      if (tracked && Number.isFinite(tracked.limit)) seats = { used: Math.max(0, tracked.used), limit: tracked.limit };
    }
    return { direct, above: levels.filter((level): level is NonNullable<typeof level> => level !== null), seats };
  });

  const [applied, setApplied] = useState<OrganizationMember[] | null>(null);
  const [changes, setChanges] = useState<Record<string, OrganizationRole | null>>({});
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState('');
  const [refusal, setRefusal] = useState<{ text: string; quota: boolean } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [invited, setInvited] = useState<PendingInvitation[]>([]);

  const failure = snapshot.status === 'error' ? classifyAuthError(snapshot.error) : null;
  const direct = applied ?? snapshot.data?.direct ?? [];
  const rows = snapshot.data ? buildRows(direct, snapshot.data.above) : [];
  const sponsor = sponsorName(organization, direct, me);
  const staged = Object.entries(changes);
  const queueFull = staged.length >= MEMBER_BATCH_LIMIT;

  const nameOf = (userId: string) => rows.find((row) => row.userId === userId)?.name ?? userId;

  const stage = (row: Row, next: OrganizationRole | null) => {
    setToast('');
    setRefusal(null);
    setChanges((current) => {
      const rest = { ...current };
      if (next === row.direct) delete rest[row.userId];
      else if (!(row.userId in rest) && Object.keys(rest).length >= MEMBER_BATCH_LIMIT) return current;
      else rest[row.userId] = next;
      return rest;
    });
  };

  const undo = (userId: string) => setChanges((current) => {
    const rest = { ...current };
    delete rest[userId];
    return rest;
  });

  const apply = async () => {
    const batch: MemberChange[] = staged.map(([user_id, next]) => ({ user_id, role: next }));
    setApplying(true);
    setToast('');
    setRefusal(null);
    try {
      const members = await platformApi.updateMembersBatch(slug, batch);
      setApplied(members);
      setChanges({});
      setToast(`${batch.length} change${batch.length === 1 ? '' : 's'} applied together. They’re recorded in the audit log.`);
      await context.reload();
    } catch (caught) {
      const refused = classifyAuthError(caught);
      setRefusal({ text: batchRefusal(refused, quotaOf(caught)), quota: refused.code === 'sponsor_quota_exceeded' });
    } finally {
      setApplying(false);
    }
  };

  const seats = snapshot.data?.seats;

  return (
    <OrgSettingsLayout
      organization={organization}
      section="members"
      title="Members"
      width="lg"
      lede={`${organization.name}${snapshot.status === 'ready' ? ` · ${rows.length} ${rows.length === 1 ? 'person' : 'people'} with a role` : ''}`}
      actions={canWrite ? (
        <Action variant="primary" onClick={() => setInviting(true)}><UserRoundPlus aria-hidden="true" className="org-inline-icon" />Invite by email</Action>
      ) : undefined}
      aside={(
        <aside className="org-queue" aria-labelledby="org-queue-title">
          <h2 id="org-queue-title">Pending changes <small>{staged.length} of {MEMBER_BATCH_LIMIT}</small></h2>
          {staged.length === 0 && (
            <span className="org-muted">
              {canWrite ? 'Change a role or remove someone in the table. Changes wait here until you apply them.' : 'Only admins can change roles.'}
            </span>
          )}
          <ul className="org-queue-list">
            {staged.map(([userId, next]) => (
              <li key={userId}>
                <span>
                  <strong>{nameOf(userId)}</strong>
                  <span className="org-queue-change">
                    <s>{rows.find((row) => row.userId === userId)?.direct ?? 'None'}</s>
                    <span aria-hidden="true">→</span>
                    <b className={next ? undefined : 'is-removed'}>{next ?? 'Removed'}</b>
                  </span>
                </span>
                <button type="button" onClick={() => undo(userId)} aria-label={`Undo change for ${nameOf(userId)}`}>Undo</button>
              </li>
            ))}
          </ul>
          {queueFull && <span className="org-muted">The queue is full: a batch holds at most {MEMBER_BATCH_LIMIT} changes. Apply these first.</span>}
          <Action variant="primary" onClick={() => void apply()} disabled={staged.length === 0 || !canWrite} busy={applying}>
            Apply {staged.length} change{staged.length === 1 ? '' : 's'}
          </Action>
          <span className="org-muted">All changes apply together or not at all. At least one OWNER must remain.</span>
        </aside>
      )}
    >
      {!canWrite && (
        <Notice tone="info">
          You’re a <strong>{role}</strong> here: you can see who’s in, but changing roles and inviting need ADMIN.
        </Notice>
      )}

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
          <Link to={`/app/${slug}/settings/audit`}>Audit log</Link>
        </div>
      )}

      {refusal && (
        <Notice
          tone="error"
          action={refusal.quota ? (
            <span className="org-notice-links">
              <Link to="/app/account/usage">See sponsor usage</Link>
              <Link to={`/app/${slug}/settings`}>Change sponsor</Link>
            </span>
          ) : undefined}
        >
          {refusal.text}
        </Notice>
      )}

      {seats && (
        <div className="org-seats">
          <span>
            Unique members across everything {sponsorIsMe ? 'you' : sponsor} sponsor{sponsorIsMe ? '' : 's'}: <strong>{seats.used} of {seats.limit}</strong>.
            {' '}Someone in two of those organizations counts once.
          </span>
          <span className="org-seat-dots" aria-hidden="true">
            {Array.from({ length: Math.min(seats.limit, 20) }, (_, index) => <i key={index} className={index < seats.used ? 'is-used' : undefined} />)}
          </span>
        </div>
      )}

      {snapshot.status === 'loading' && (
        <div aria-busy="true" role="status"><span className="sr-only">Loading members…</span><Skeleton variant="panel" /></div>
      )}

      {failure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={snapshot.reload}>Try again</Action>}>
          {isForbidden(failure)
            ? `You can’t see the members of this organization${marker(failure)}.`
            : `Members couldn’t be loaded${marker(failure)}. Nothing was changed.`}
        </Notice>
      )}

      {snapshot.status === 'ready' && (
        <>
          <DataTable label={`Members of ${organization.name}`} minWidth={600}>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role here</th>
                <th scope="col">Effective role</th>
                <th scope="col">Added</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const hasChange = row.userId in changes;
                const shown = hasChange ? changes[row.userId] : row.direct;
                const effective = effectiveOf(row);
                const isMe = row.userId === user?.id;
                return (
                  <tr key={row.userId} className={hasChange ? 'is-staged' : undefined}>
                    <td>
                      <span className="org-person">
                        <span className="org-avatar is-sm" aria-hidden="true">{row.name.slice(0, 2).toUpperCase()}</span>
                        <span>
                          <strong>{row.name}{isMe && <small> (you)</small>}</strong>
                          {row.email && <small>{row.email}</small>}
                        </span>
                      </span>
                    </td>
                    <td>
                      {canWrite ? (
                        <select
                          className={`org-role-select${hasChange ? ' is-staged' : ''}`}
                          aria-label={`Role for ${row.name}`}
                          value={shown ?? NO_DIRECT_ROLE}
                          onChange={(event) => stage(row, event.target.value === NO_DIRECT_ROLE ? null : event.target.value as OrganizationRole)}
                        >
                          {ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
                          <option value={NO_DIRECT_ROLE}>No direct role</option>
                        </select>
                      ) : row.direct ? <RoleChip role={row.direct} /> : <span className="org-role is-none">None here</span>}
                    </td>
                    <td>
                      <span className="org-effective">
                        <RoleChip role={effective.role} />
                        <small>{effective.source}</small>
                      </span>
                    </td>
                    <td className="org-muted-cell">{formatDate(row.addedAt) ?? '—'}</td>
                    <td className="org-actions-cell">
                      {canWrite && row.direct && (
                        <button
                          type="button"
                          className="org-remove"
                          aria-label={`Remove ${row.name}`}
                          aria-pressed={hasChange && changes[row.userId] === null}
                          onClick={() => stage(row, hasChange && changes[row.userId] === null ? row.direct : null)}
                        >
                          {hasChange && changes[row.userId] === null ? 'Will be removed' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {invited.map((item) => (
                <tr key={item.id} className="is-pending">
                  <td>
                    <span className="org-person">
                      <span className="org-avatar is-sm is-dashed" aria-hidden="true">@</span>
                      <span><strong>{item.email}</strong><small>Invitation pending</small></span>
                    </span>
                  </td>
                  <td><RoleChip role={item.role} /></td>
                  <td className="org-muted-cell">On accepting</td>
                  <td className="org-muted-cell">Expires {formatDate(item.expiresAt) ?? '—'}</td>
                  <td />
                </tr>
              ))}
            </tbody>
          </DataTable>

          {rows.length <= 1 && invited.length === 0 && (
            <div className="org-empty is-row">
              <span>You’re the only member so far. Invite people by email; they choose to accept.</span>
              {canWrite && <Action variant="secondary" size="sm" onClick={() => setInviting(true)}>Invite someone</Action>}
            </div>
          )}

          <p className="org-muted">
            Inherited roles come from the parent organizations you can see and are changed there. Invitations are listed only until you leave this page:
            the API returns an invitation once, when it is created.
          </p>
        </>
      )}

      {inviting && (
        <InviteDialog
          organization={organization}
          sponsor={sponsor}
          onClose={() => setInviting(false)}
          onInvited={(invitation) => setInvited((current) => [...current, { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expires_at }])}
        />
      )}
    </OrgSettingsLayout>
  );
}

/** Members and invitations (`org-members`, `/app/:org/settings/members`). */
export function OrgMembers() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <div className="org-page"><PageSkeleton /></div>;
  if (!organization) return <div className="org-page"><NeutralGate /></div>;
  return <MembersBody organization={organization} />;
}
