import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { isSponsorProposal, QuotaError } from '../../api/auth';
import type { AdminUserView, SponsorProposal } from '../../api/auth';
import { apiClient, HttpError } from '../../api/client';
import { platformApi, type Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { describeLimit, limitInfo } from '../../utils/limits';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { SponsorRequestCard } from '../Organization/SponsorCards';
import { pendingOf, sponsorRefusal } from '../Organization/sponsorModel';
import { AdminFrame, AdminOnly, FailureNotice, Tag } from './AdminChrome';
import { describeAdminFailure, planTone, shortId, UUID, type Failure } from './adminModel';

/** The limits a sponsor’s plan sets on everything under the organizations it sponsors. */
const SPONSORED = ['organizations', 'members', 'projects', 'privateProjects', 'collections', 'studies', 'storageBytes'] as const;

interface Found {
  /** `null` when this account may not read the organization (administrators who are not members). */
  organization: Organization | null;
}

async function loadOrganization(param: string): Promise<Found> {
  try {
    return { organization: await platformApi.organization(param) };
  } catch (error: unknown) {
    if (error instanceof HttpError && (error.status === 403 || error.status === 404)) return { organization: null };
    throw error;
  }
}

/** The organization and every one below it that the account can see, parents first. */
function subtreeOf(root: Organization, all: Organization[]): Array<{ organization: Organization; depth: number }> {
  const result: Array<{ organization: Organization; depth: number }> = [];
  const visit = (organization: Organization, depth: number) => {
    result.push({ organization, depth });
    all.filter((child) => child.parent_id === organization.id).forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return result;
}

function SponsorScreen({ param }: { param: string }) {
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; text: string; tone: 'error' | 'warning' } | null>(null);
  const [orgInput, setOrgInput] = useState('');
  /** The request just sent, shown at once while the list is read again. */
  const [sent, setSent] = useState<SponsorProposal | null>(null);
  /** A request was already waiting when somebody else was named: its sender may replace it. */
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const found = useResource(`admin-sponsor-org:${param}`, () => loadOrganization(param));
  const organization = (found.data ?? found.stale)?.organization ?? null;
  const organizationId = organization?.id ?? (UUID.test(param) ? param : null);
  const sponsorId = organization?.billing_sponsor_user_id ?? null;

  const requestsFor = organization?.slug ?? organizationId;
  const requests = useResource<SponsorProposal[] | null>(`admin-sponsor-requests:${requestsFor ?? ''}`, async () => {
    if (!requestsFor) return null;
    try {
      return await apiClient.listOrganizationSponsorProposals(requestsFor);
    } catch {
      return null;
    }
  });
  const waitingRequest = pendingOf(requests.data) ?? (sent && sent.status === 'pending' ? sent : null);
  const sentByMe = Boolean(waitingRequest && me && waitingRequest.proposed_by_user_id === me.id);

  const sponsor = useResource(`admin-sponsor-current:${sponsorId ?? ''}`, async () => (sponsorId ? (await apiClient.adminGetSubscription(sponsorId).catch(() => null)) : null));
  const visible = useResource(`admin-sponsor-tree:${organization?.id ?? ''}`, async () => (organization ? subtreeOf(organization, await platformApi.organizations().catch(() => [organization])) : []));
  const search = useResource(`admin-sponsor-search:${query}`, async () => (query.length >= 2 ? apiClient.adminListUsers({ search: query, limit: 20 }) : null));

  const candidates: AdminUserView[] = (search.data ?? search.stale)?.users ?? [];
  const target = candidates.find((account) => account.id === targetId) ?? null;
  const limits = useResource(`admin-sponsor-limits:${target?.id ?? ''}`, async () => (target ? apiClient.adminGetUserUsage(target.id) : null));
  const catalog = useResource('admin-sponsor-catalog', () => apiClient.getPricingCatalog().catch(() => null));
  const definitions = useMemo(() => (catalog.data?.usageLimits ?? {}) as Record<string, Record<string, unknown>>, [catalog.data]);

  const failure: Failure | null = found.status === 'error' ? describeAdminFailure(found.error, 'The organization couldn’t be read') : null;
  const currentSponsor = (sponsor.data ?? sponsor.stale)?.user ?? null;
  const tree = visible.data ?? visible.stale ?? [];
  const eligible = target ? target.is_active && target.id !== sponsorId : false;
  const carried = limits.data?.capabilities ?? null;

  const open = (event: FormEvent) => {
    event.preventDefault();
    const value = orgInput.trim();
    if (value) void navigate(`/app/admin/organizations/${encodeURIComponent(value)}/sponsor`);
  };

  // Naming yourself changes the sponsor at once; naming anybody else sends them a request that they have to accept.
  const namesSelf = Boolean(target && me && target.id === me.id);

  const transfer = async (replace = false) => {
    if (!organizationId || !target) return;
    setBusy(true);
    setRefusal(null);
    setReplacing(false);
    try {
      const result = replace
        ? await apiClient.adminTransferSponsor(organizationId, target.id, true)
        : await apiClient.adminTransferSponsor(organizationId, target.id);
      if (isSponsorProposal(result)) {
        setSent(result);
        setDone(`Sponsor request sent to ${target.username}. Nothing changes until they accept; it lapses after 14 days. It is recorded in the audit log.`);
      } else {
        setSent(null);
        setDone(`Sponsorship of ${organization?.name ?? param} moved to ${target.username}. It is recorded in the audit log.`);
      }
      setTargetId('');
      setDraft('');
      setQuery('');
      found.reload();
      requests.reload();
    } catch (error: unknown) {
      if (error instanceof QuotaError) {
        const quota = error.quota;
        const label = quota ? limitInfo(quota.limit_id, definitions[quota.limit_id]).label.toLowerCase() : 'its limits';
        setRefusal({
          tone: 'error',
          title: 'Over the new sponsor’s limits (402 · sponsor_quota_exceeded)',
          text: quota
            ? `${target.username}’s ${target.plan} plan allows ${quota.limit.toLocaleString('en-US')} ${label}; with this organization they would use ${(quota.used ?? 0).toLocaleString('en-US')}. Choose another account, or change their agreement first. The gateway names the first limit it finds over; others may be over too.`
            : error.message,
        });
      } else {
        const refused = describeAdminFailure(error, 'The sponsorship couldn’t be moved');
        if (refused.code === 'invalid_sponsor') {
          setRefusal({ tone: 'error', title: 'That account can’t be a sponsor (422 · invalid_sponsor)', text: 'Sponsors must be active accounts.' });
        } else if (refused.code === 'sponsor_proposal_pending') {
          // Whoever sent the waiting request may replace it; anybody else cancels it first. The list says which this is.
          setReplacing(true);
          requests.reload();
          setRefusal({ tone: 'error', title: 'A request is already waiting (409 · sponsor_proposal_pending)', text: 'This organization already has a sponsor request waiting for an answer. Replace it if you sent it; otherwise cancel it first.' });
        } else if (refused.code === 'already_sponsor') {
          setRefusal({ tone: 'error', title: 'That account is already the sponsor (409 · already_sponsor)', text: 'Pick another account.' });
        } else if (refused.code === 'sponsor_proposal_expired' || refused.code === 'sponsor_proposal_not_pending') {
          setRefusal({ tone: 'error', title: refused.title, text: sponsorRefusal(error, 'propose').text });
        } else {
          setRefusal({ tone: refused.tone, title: refused.title, text: refused.text });
        }
      }
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const cancelRequest = async (proposal: SponsorProposal) => {
    setCancelling(true);
    setRefusal(null);
    try {
      await apiClient.cancelSponsorProposal(proposal.id);
      setSent(null);
      setReplacing(false);
      setDone('Sponsor request cancelled. The sponsor stays as it was.');
      requests.reload();
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'The request couldn’t be cancelled');
      setRefusal({ tone: refused.tone, title: refused.title, text: sponsorRefusal(error, 'cancel').text });
    } finally {
      setCancelling(false);
    }
  };

  const title = organization?.name ?? param;
  const trail = [{ label: 'Administration', to: '/app/admin' }, { label: 'Transfer sponsorship' }];

  return (
    <AdminFrame
      section="overview"
      trail={trail}
      title="Transfer sponsorship"
      lede="The sponsor’s plan is what an organization and everything under it counts against: members, projects, storage and so on. Nobody can make another person pay: naming someone else sends them a request, and it moves only when they accept and their plan fits the combined use."
    >
      {failure && <FailureNotice failure={failure} onRetry={found.reload} />}
      {done && <Notice tone="success">{done}</Notice>}
      {waitingRequest && (
        <SponsorRequestCard
          proposal={waitingRequest}
          cancel={{ busy: cancelling, onCancel: () => void cancelRequest(waitingRequest) }}
          replace={replacing && sentByMe && target ? { busy, onReplace: () => void transfer(true) } : undefined}
        >
          {replacing && !sentByMe && <span className="adm-muted">Someone else sent this request. Cancel it first, then send yours.</span>}
        </SponsorRequestCard>
      )}

      <div className="adm-two">
        <section className="adm-card" aria-labelledby="adm-sponsor-org">
          <h2 id="adm-sponsor-org">1 · Organization</h2>
          {found.status === 'loading' && !found.stale && <div aria-busy="true"><span className="sr-only">Reading the organization</span><Skeleton variant="tile" /></div>}
          {found.status === 'ready' && (
            <div className="adm-org">
              <strong>{title}</strong>
              {organization ? <span className="adm-muted is-mono">{organization.slug}</span> : <span className="adm-muted is-mono">{param}</span>}
              <span className="adm-muted">
                Sponsor: {organization
                  ? (currentSponsor ? <><strong>{currentSponsor.username}</strong> <Tag tone={planTone(currentSponsor.plan)}>{currentSponsor.plan}</Tag></> : <span className="is-mono">{shortId(sponsorId)}</span>)
                  : 'not shown'}
              </span>
            </div>
          )}

          {found.status === 'ready' && !organization && !organizationId && (
            <>
              <Notice tone="warning" title="This organization can’t be read by name">
                The gateway lets an administrator move a sponsorship, but only reads an organization by name for its members. Use the organization’s id.
              </Notice>
              <form className="adm-inline-form" onSubmit={open}>
                <label className="adm-field">
                  <span className="adm-label">Organization id</span>
                  <input value={orgInput} onChange={(event) => setOrgInput(event.target.value)} placeholder="Paste the organization id" autoComplete="off" spellCheck={false} />
                </label>
                <Action type="submit" variant="secondary" disabled={!UUID.test(orgInput.trim())}>Open</Action>
              </form>
            </>
          )}
          {found.status === 'ready' && !organization && organizationId && (
            <Notice tone="info" title="Only the id is known">
              You aren’t a member of this organization, so the gateway doesn’t show its name, current sponsor or sub-organizations. The transfer still works with the id.
            </Notice>
          )}

          {organization && (
            <div className="adm-tree">
              <span className="adm-label">Moves together</span>
              <ul>
                {tree.map(({ organization: item, depth }) => (
                  <li key={item.id} style={{ paddingLeft: depth * 18 }}><span aria-hidden="true">{depth ? '└' : '■'}</span> {item.name}</li>
                ))}
              </ul>
              <span className="adm-muted">The gateway moves the whole subtree. You see the organizations you belong to.</span>
            </div>
          )}
        </section>

        <section className="adm-card" aria-labelledby="adm-sponsor-target">
          <h2 id="adm-sponsor-target">2 · New sponsor</h2>
          <label className="adm-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search accounts</span>
            <input type="search" value={draft} onChange={(event) => { setDraft(event.target.value); setDone(null); }} placeholder="Username or email of the new sponsor" autoComplete="off" spellCheck={false} />
          </label>
          {search.status === 'error' && <FailureNotice failure={describeAdminFailure(search.error, 'Accounts couldn’t be searched')} onRetry={search.reload} />}
          {query.length >= 2 && search.status === 'ready' && candidates.length === 0 && <span className="adm-muted">No account matches “{query}”.</span>}
          <div role="radiogroup" aria-label="New sponsor" className="adm-candidates">
            {candidates.map((account) => {
              const already = account.id === sponsorId;
              return (
                <button
                  key={account.id}
                  type="button"
                  role="radio"
                  aria-checked={account.id === targetId}
                  className={`adm-choice${account.id === targetId ? ' is-on' : ''}`}
                  disabled={already}
                  onClick={() => { setTargetId(account.id); setRefusal(null); setDone(null); }}
                >
                  <strong>{account.username}</strong>
                  <span>{account.plan} · {already ? 'current sponsor' : account.is_active ? 'active' : 'inactive'}</span>
                </button>
              );
            })}
          </div>
          {!target && <span className="adm-muted">Pick an account to see the limits it would carry for {title}.</span>}
        </section>
      </div>

      {target && (
        <section className="adm-card" aria-labelledby="adm-sponsor-limits">
          <div className="adm-card-head">
            <h2 id="adm-sponsor-limits">3 · What {target.username} could carry</h2>
            <Tag tone={eligible ? 'success' : 'error'}>{target.is_active ? 'Can sponsor' : 'Can’t sponsor'}</Tag>
          </div>
          {limits.status === 'loading' && !limits.stale && <div role="status" aria-busy="true"><Skeleton variant="tile" /><span className="sr-only">Reading the new sponsor’s limits</span></div>}
          {limits.status === 'error' && <FailureNotice failure={describeAdminFailure(limits.error, 'Their limits couldn’t be read')} onRetry={limits.reload} />}
          {!target.is_active && (
            <Notice tone="error" title="That account can’t be a sponsor (422 · invalid_sponsor)">Sponsors must be active accounts. {target.username} is inactive.</Notice>
          )}
          {carried && (
            <DataTable label="Sponsored limits of the new sponsor" minWidth={460}>
              <thead><tr><th scope="col">Limit</th><th scope="col">{target.username} allows</th></tr></thead>
              <tbody>
                {SPONSORED.filter((id) => id in carried).map((id) => {
                  const info = limitInfo(id, definitions[id]);
                  const allowed = describeLimit(info.kind, carried[id]);
                  return <tr key={id}><td>{info.label}</td><td title={allowed.exact}>{allowed.text}</td></tr>;
                })}
              </tbody>
            </DataTable>
          )}
          <span className="adm-muted">
            {namesSelf
              ? <>The gateway has no dry run. When you transfer, it adds this organization and everything under it to what {target.username} already sponsors, counting members once, and refuses with a 402 naming the first limit that would be passed. Nothing moves unless every limit fits.</>
              : <>This sends {target.username} a request; nothing moves until they accept. They accept with their own plan: the gateway then adds this organization and everything under it to what they already sponsor, counting members once, and refuses with a 402 naming the first limit that would be passed. The request stays open so they can try again.</>}
          </span>
          {refusal && <Notice tone={refusal.tone} title={refusal.title}>{refusal.text}</Notice>}
          <div className="adm-buttons">
            <Action variant="primary" disabled={!eligible || !organizationId || busy} onClick={() => setConfirm(true)}>{namesSelf ? 'Transfer sponsorship' : 'Send sponsor request'}</Action>
            <span className="adm-muted">{eligible ? 'Recorded in the audit log.' : 'Pick an active account that isn’t already the sponsor.'}</span>
          </div>
        </section>
      )}

      {confirm && target && (
        <ConfirmDialog
          title={namesSelf ? `Transfer sponsorship of ${title}?` : `Ask ${target.username} to sponsor ${title}?`}
          confirmLabel={namesSelf ? 'Transfer' : 'Send request'}
          busy={busy}
          onConfirm={() => void transfer()}
          onClose={() => setConfirm(false)}
        >
          {namesSelf ? (
            <p>
              From {currentSponsor?.username ?? (sponsorId ? shortId(sponsorId) : 'the current sponsor')} to <strong>{target.username}</strong>.
              {' '}{Math.max(1, tree.length)} {Math.max(1, tree.length) === 1 ? 'organization' : 'organizations'} will count against {target.plan} limits from now on.
            </p>
          ) : (
            <p>
              <strong>{target.username}</strong> will be asked to become the sponsor of {title}. Nothing changes until they accept; if they do,
              {' '}{Math.max(1, tree.length)} {Math.max(1, tree.length) === 1 ? 'organization' : 'organizations'} will count against their {target.plan} limits.
              The request lapses after 14 days.
            </p>
          )}
          <p className="adm-muted">This is recorded in the audit log with your name.</p>
        </ConfirmDialog>
      )}
    </AdminFrame>
  );
}

/** admin-sponsor: change the billing sponsor of an organization and its subtree, with the new sponsor’s limits in view. */
export function AdminSponsor() {
  const { org } = useParams();
  return <AdminOnly><SponsorScreen key={org} param={org ?? ''} /></AdminOnly>;
}
