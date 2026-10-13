import { useState } from 'react';
import { Link, useLocation, useOutletContext } from 'react-router-dom';
import { FilePlus2, Play, Plus, ShieldCheck, type LucideIcon } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { JobSummary } from '../../api/client';
import type { Notification } from '../../api/auth';
import { platformApi } from '../../api/platform';
import type { Organization } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { config } from '../../config';
import { useAuth } from '../../contexts/auth';
import { formatDate, formatDateTime } from '../../utils/format';
import { formatCount, formatDuration } from '../../utils/limits';
import { useResource } from '../../utils/useResource';
import { contractChange } from '../Account/notificationsModel';
import { usageRows } from '../Account/usageModel';
import { classifyAuthError, generalFailure, isForbidden, marker } from '../Organization/orgErrors';
import { buildForest, roleSource, type TreeNode } from '../Organization/orgModel';
import { OrgTile, RoleChip } from '../Organization/parts';
import './AppHome.css';

interface Shortcut {
  label: string;
  to: string;
  icon: LucideIcon;
}

type StatusTone = 'running' | 'queued' | 'ok' | 'warn' | 'bad';

/** How a job reads in the activity list: the word, and the tone of its dot and chip. */
function jobStatus(job: JobSummary): { label: string; tone: StatusTone } {
  switch (job.status) {
    case 'running': return { label: 'Running', tone: 'running' };
    case 'queued': return { label: 'Queued', tone: 'queued' };
    case 'failed': return { label: 'Failed', tone: 'bad' };
    default:
      if (job.termination === 'INFEASIBLE') return { label: 'No feasible binding', tone: 'warn' };
      if (job.termination === 'OPTIMAL') return { label: 'Optimal', tone: 'ok' };
      if (job.termination === 'FEASIBLE') return { label: 'Feasible', tone: 'ok' };
      return { label: job.termination === 'UNKNOWN' ? 'Unknown' : 'Completed', tone: job.termination === 'UNKNOWN' ? 'warn' : 'ok' };
  }
}

function jobMeta(job: JobSummary): string {
  const started = formatDateTime(job.created_at) ?? job.created_at;
  const seconds = job.finished_at ? (Date.parse(job.finished_at) - Date.parse(job.created_at)) / 1000 : null;
  return `Job ${job.id.slice(0, 8)}… · started ${started}${seconds !== null && seconds >= 0 ? ` · finished in ${formatDuration(seconds)}` : ''}`;
}

function OrgBranch({ node, all, userId }: { node: TreeNode; all: Organization[]; userId: string | undefined }) {
  const { organization } = node;
  const source = roleSource(organization, all);
  const sponsored = organization.billing_sponsor_user_id === userId;
  return (
    <li>
      <Link to={`/app/${organization.slug}`} viewTransition className="home-org">
        {node.depth > 0 && <span className="home-org-elbow" aria-hidden="true" />}
        <OrgTile organization={organization} />
        <span className="home-org-body">
          <strong>{organization.name}</strong>
          <small>{organization.slug}{sponsored ? ' · you sponsor it' : ''} · {source.kind === 'inherited' ? 'inherited role' : 'own role'}</small>
        </span>
        <RoleChip role={organization.effective_role} title={source.text} />
      </Link>
      {node.children.length > 0 && (
        <ul className="home-org-children">
          {node.children.map((child) => <OrgBranch key={child.organization.id} node={child} all={all} userId={userId} />)}
        </ul>
      )}
    </li>
  );
}

function ActivityBlock() {
  const jobs = useResource('home-activity', () => apiClient.listOwnJobs({ limit: 5 }));
  const failure = jobs.status === 'error' ? classifyAuthError(jobs.error) : null;
  const items = jobs.data?.jobs ?? [];
  return (
    <section className="apphome-card" aria-labelledby="home-activity-title" aria-busy={jobs.status === 'loading'}>
      <header className="home-card-head">
        <h2 id="home-activity-title">Recent activity</h2>
        <Link to="/app/jobs" viewTransition>All jobs</Link>
      </header>
      {jobs.status === 'loading' && <div className="home-skeleton" role="status"><span className="sr-only">Loading recent jobs…</span><Skeleton variant="tile" /><Skeleton variant="tile" /><Skeleton variant="tile" /></div>}
      {failure && isForbidden(failure) && <p className="home-blocked">Not available with this key (needs jobs: read).</p>}
      {failure && !isForbidden(failure) && (
        <div className="home-pad">
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={jobs.reload}>Retry</Action>}>
            Recent jobs couldn’t be loaded{marker(failure)}. The other blocks are unaffected.
          </Notice>
        </div>
      )}
      {jobs.status === 'ready' && items.length === 0 && (
        <div className="home-guide">
          <strong>No jobs yet. Here’s a way to your first run.</strong>
          <ol>
            <li><Link to="/workbench">Open the Workbench</Link> and validate a package, or <Link to="/examples">start from an example</Link>.</li>
            <li>Open or create a project to keep its cases, runs and reports together.</li>
            <li>Launch a run from the project; it appears here while it works.</li>
          </ol>
        </div>
      )}
      {items.length > 0 && (
        <ul className="home-activity">
          {items.map((job) => {
            const status = jobStatus(job);
            return (
              <li key={job.id}>
                <Link to="/app/jobs" viewTransition>
                  <span className={`home-dot is-${status.tone}`} aria-hidden="true" />
                  <span className="home-activity-body"><strong>{job.engine_id}</strong><small>{jobMeta(job)}</small></span>
                  <span className={`home-status is-${status.tone}`}>{status.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PlanBlock() {
  const usage = useResource('home-usage', () => apiClient.getOwnUsage());
  const failure = usage.status === 'error' ? classifyAuthError(usage.error) : null;
  const data = usage.data;
  const rows = data ? usageRows(data) : [];
  const picks: Array<{ id: string; label: string; format: (value: number) => string }> = [
    { id: 'concurrentJobs', label: 'Jobs at once', format: formatCount },
    { id: 'apiKeys', label: 'API keys', format: formatCount },
  ];
  return (
    <section className="apphome-card is-padded" aria-labelledby="home-plan-title" aria-busy={usage.status === 'loading'}>
      <header className="home-card-head is-bare">
        <h2 id="home-plan-title">Your plan</h2>
        <Link to="/app/account/usage" viewTransition>Plan &amp; permissions</Link>
      </header>
      {usage.status === 'loading' && <Skeleton variant="panel" />}
      {failure && isForbidden(failure) && <p className="home-blocked">Not available with this key (needs account: read).</p>}
      {failure && !isForbidden(failure) && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={usage.reload}>Retry</Action>}>
          {failure.code === 'pricing_unavailable' || failure.kind === 'unavailable'
            ? `Your plan can’t be loaded right now${marker(failure)}. Nothing else on this page depends on it.`
            : generalFailure(failure, 'no plan is shown')}
        </Notice>
      )}
      {data?.contract_pending && (
        <Notice tone="warning">Your plan is still being settled (contract pending). Limits appear here once it’s confirmed.</Notice>
      )}
      {data && !data.contract_pending && (
        <>
          <div className="home-untracked"><span>Plan</span><strong>{data.plan}</strong></div>
          {picks.map((pick) => {
            const row = rows.find((item) => item.id === pick.id);
            if (!row) return null;
            return <div key={pick.id} className="home-untracked"><span>{pick.label}</span><strong>{row.limit === null ? 'Unlimited' : `Up to ${pick.format(row.limit)}`}</strong></div>;
          })}
        </>
      )}
      <span className="home-muted">
        Plans and contracts are managed in the native consoles:{' '}
        <a href={config.spaceFrontendUrl} target="_blank" rel="noopener noreferrer">SPACE</a>
        {' · '}
        <a href={config.sphereUrl} target="_blank" rel="noopener noreferrer">SPHERE</a>.
      </span>
    </section>
  );
}

function NotificationsBlock({ announce }: { announce: (text: string) => void }) {
  const unread = useResource('home-notifications', () => apiClient.listNotifications(true));
  const failure = unread.status === 'error' ? classifyAuthError(unread.error) : null;
  const [reading, setReading] = useState('');
  const items = (unread.data ?? []).filter((item) => !item.read_at);

  const markRead = async (item: Notification) => {
    setReading(item.id);
    try {
      await apiClient.markNotificationRead(item.id);
      announce('Notification marked as read.');
      unread.reload();
    } catch {
      announce('That notification couldn’t be marked as read. Try again.');
    } finally {
      setReading('');
    }
  };

  return (
    <section className="apphome-card is-padded" aria-labelledby="home-notifications-title" aria-busy={unread.status === 'loading'}>
      <header className="home-card-head is-bare">
        <h2 id="home-notifications-title">Unread notifications</h2>
        <Link to="/app/account/notifications" viewTransition>All</Link>
      </header>
      {unread.status === 'loading' && <Skeleton variant="tile" />}
      {failure && isForbidden(failure) && <p className="home-blocked">Not available with this key (needs notifications: read).</p>}
      {failure && !isForbidden(failure) && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={unread.reload}>Retry</Action>}>
          Notifications couldn’t be loaded{marker(failure)}.
        </Notice>
      )}
      {unread.status === 'ready' && items.length === 0 && <span className="home-muted">You’re all caught up.</span>}
      {items.slice(0, 3).map((item) => {
        const change = contractChange(item);
        return (
          <div key={item.id} className="home-notification">
            <strong>{item.subject}</strong>
            <span className="home-notification-line">
              {change && (
                <>
                  <Chip>{change.before.plan}</Chip><span aria-hidden="true">→</span><Chip tone="accent">{change.after.plan}</Chip>
                </>
              )}
              <span className="home-muted">{change ? '· ' : ''}{formatDate(item.created_at) ?? item.created_at}</span>
            </span>
            <button type="button" className="home-link-button" disabled={reading === item.id} onClick={() => void markRead(item)}>Mark as read</button>
          </div>
        );
      })}
      {items.length > 3 && <Link to="/app/account/notifications" viewTransition className="home-more">{items.length - 3} more unread</Link>}
    </section>
  );
}

/** Home (`app-home`, `/app`): the organizations you can reach, recent jobs, your plan and unread notices. */
export function AppHome() {
  const context = useOutletContext<PlatformOutletContext>();
  const { user, isAdmin } = useAuth();
  const location = useLocation();
  const [announcement, setAnnouncement] = useState('');
  const deleted = (location.state as { deletedOrganization?: string } | null)?.deletedOrganization;

  const orgs = useResource('home-organizations', () => platformApi.organizations());
  const usage = useResource('home-plan-usage', () => apiClient.getOwnUsage().catch(() => null));
  const failure = orgs.status === 'error' ? classifyAuthError(orgs.error) : null;
  const list: Organization[] = orgs.data ?? [];
  const forest = buildForest(list);
  const empty = orgs.status === 'ready' && list.length === 0;

  const organization = context.organization ?? list[0];
  const project = context.project;
  const shortcuts: Shortcut[] = [];
  if (organization) shortcuts.push({ label: 'New project', to: `/app/${organization.slug}/new-project`, icon: Plus });
  if (organization && project) {
    shortcuts.push({ label: 'New case', to: `/app/${organization.slug}/${project.slug}/cases`, icon: FilePlus2 });
    shortcuts.push({ label: 'Run', to: `/app/${organization.slug}/${project.slug}/jobs/new`, icon: Play });
  }
  shortcuts.push({ label: 'Verify a digest', to: '/app/verifier', icon: ShieldCheck });

  const subtitle = isAdmin
    ? 'You’re a platform administrator. Admin tools are in the header.'
    : list.length > 0 ? 'Pick up where you left off.' : 'Let’s set up a place for your work.';
  const limit = usage.data?.capabilities.organizations;

  return (
    <div className="apphome-page">
      <div className="home-head">
        <div>
          <h1>Hello, {user?.username ?? 'there'}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="home-shortcuts">
          {shortcuts.map(({ label, to, icon: Icon }) => (
            <Link key={label} to={to} viewTransition><Icon aria-hidden="true" />{label}</Link>
          ))}
        </div>
      </div>

      {deleted && <Notice tone="success">{deleted} was deleted, together with everything inside it.</Notice>}

      {empty && (
        <section className="home-first" aria-labelledby="home-first-title">
          <div className="home-first-art" aria-hidden="true">
            <span className="is-root" />
            <span className="is-line" />
            <span className="is-pair"><i /><i /></span>
          </div>
          <div className="home-first-body">
            <h2 id="home-first-title">Create your first organization</h2>
            <span>
              Organizations hold projects, members and a shared library. You can nest them: a lab inside a group inherits the group’s roles.
              Projects, inside an organization, hold your cases, studies and reports.
              {' '}You’ll sponsor it: it counts against your plan’s organization limit{typeof limit === 'number' ? ` (${limit} on ${usage.data?.plan})` : ''}.
            </span>
            <span className="home-first-actions">
              <Action to="/app/organizations/new" variant="primary">Create organization</Action>
              <Link to="/invitations/accept">I have an invitation</Link>
            </span>
          </div>
        </section>
      )}

      <div className="home-columns">
        <section className="apphome-card home-orgs" aria-labelledby="home-orgs-title" aria-busy={orgs.status === 'loading'}>
          <header className="home-card-head">
            <h2 id="home-orgs-title">Your organizations</h2>
            <Link to="/app/organizations/new" viewTransition>+ New</Link>
          </header>
          {orgs.status === 'loading' && <div className="home-skeleton" role="status"><span className="sr-only">Loading organizations…</span><Skeleton variant="tile" /><Skeleton variant="tile" /><Skeleton variant="tile" /></div>}
          {failure && isForbidden(failure) && <p className="home-blocked">Not available with this key (needs organizations: read).</p>}
          {failure && !isForbidden(failure) && (
            <div className="home-pad">
              <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={orgs.reload}>Retry</Action>}>
                Your organizations couldn’t be loaded{marker(failure)}. The other blocks are unaffected.
              </Notice>
            </div>
          )}
          {empty && (
            <p className="home-blocked">
              {isAdmin ? 'You aren’t a member of any organization yet.' : 'You’re not in any organization yet.'}
            </p>
          )}
          {forest.length > 0 && (
            <>
              <ul className="home-org-tree" aria-label="Organizations">
                {forest.map((node) => <OrgBranch key={node.organization.id} node={node} all={list} userId={user?.id} />)}
              </ul>
              <p className="home-card-foot">Your role in a sub-organization is the highest of your own role there and the one inherited from above.</p>
            </>
          )}
        </section>

        <div className="home-side">
          <ActivityBlock />
          <div className="home-pair">
            <PlanBlock />
            <NotificationsBlock announce={setAnnouncement} />
          </div>
        </div>
      </div>
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </div>
  );
}
