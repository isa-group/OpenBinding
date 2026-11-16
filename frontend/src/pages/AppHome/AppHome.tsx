import { useState } from 'react';
import { Link, useLocation, useOutletContext } from 'react-router-dom';
import { Building2, FilePlus2, Layers, Play, type LucideIcon } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { Notification } from '../../api/auth';
import { platformApi } from '../../api/platform';
import type { Job, Organization } from '../../api/platform';
import { runsApi } from '../../api/runs';
import type { PlatformOutletContext } from '../../routes/LegacyOrgOutlet';
import { Action } from '../../modules/core/components/action-button';
import { Chip } from '../../modules/core/components/chip';
import { Notice } from '../../modules/core/components/notice';
import { Skeleton } from '../../modules/core/components/skeleton';
import { config } from '../../config';
import { useAuth } from '../../modules/auth/hooks/useAuth';
import { compositionsApi } from '../../modules/core/utils/composition/api';
import { kindLabel } from '../../modules/core/utils/composition/kinds';
import { valueStatus } from '../../modules/core/utils/composition/values';
import { lastOrganization } from '../../features/workspace/lastOrganization';
import { compositionPath, compositionsPath } from '../../routes/paths/compositions';
import { problemEditorPath, problemsPath } from '../../routes/paths/problems';
import { launchPath, runPath, runsPath } from '../../routes/paths/runs';
import { formatDate } from '../../utils/format';
import { formatCount, formatDuration, LIMIT } from '../../utils/limits';
import { runLabel } from '../../modules/core/utils/identity';
import { useResource } from '../../utils/useResource';
import { ValueBadge } from '../../modules/core/components/value-badge/ValueBadge';
import { contractChange } from '../Account/notificationsModel';
import { usageRows } from '../Account/usageModel';
import { isForbidden } from '../../modules/organization/pages/organization-detail/orgErrors';
import { generalFailure } from '../../features/workspace/errors';
import { classifyAuthError, marker } from '../../modules/core/api/errors';
import {
  atLeast,
  buildForest,
  roleSource,
  type TreeNode,
} from '../../modules/organization/utils/org-tree';
import { OrgTile, RoleChip } from '../Organization/parts';
import './AppHome.css';

/** Shown instead of a blank value when no plan name is known (local demo without remote entitlements). */
const NO_PLAN_TEXT = 'No remote plan (local demo)';

interface Shortcut {
  label: string;
  to: string;
  icon: LucideIcon;
}

type StatusTone = 'running' | 'queued' | 'ok' | 'warn' | 'bad';

/** How a job reads in the activity list: the word, and the tone of its dot and chip. */
function jobStatus(job: Job): { label: string; tone: StatusTone } {
  switch (job.status) {
    case 'running':
      return { label: 'Running', tone: 'running' };
    case 'queued':
      return { label: 'Queued', tone: 'queued' };
    case 'failed':
      return { label: 'Failed', tone: 'bad' };
    default:
      if (job.termination === 'INFEASIBLE') return { label: 'No feasible binding', tone: 'warn' };
      if (job.termination === 'OPTIMAL') return { label: 'Optimal', tone: 'ok' };
      if (job.termination === 'FEASIBLE') return { label: 'Feasible', tone: 'ok' };
      return {
        label: job.termination === 'UNKNOWN' ? 'Unknown' : 'Completed',
        tone: job.termination === 'UNKNOWN' ? 'warn' : 'ok',
      };
  }
}

function jobMeta(job: Job): string {
  const seconds = job.finished_at
    ? (Date.parse(job.finished_at) - Date.parse(job.created_at)) / 1000
    : null;
  const label = runLabel({ engine: { name: job.engine_id }, createdAt: job.created_at });
  return `${label}${seconds !== null && seconds >= 0 ? ` · finished in ${formatDuration(seconds)}` : ''}`;
}

function OrgBranch({ node, all }: { node: TreeNode; all: Organization[] }) {
  const { organization } = node;
  const source = roleSource(organization, all);
  return (
    <li>
      <Link to={`/orgs/${organization.slug}`} viewTransition className="home-org">
        {node.depth > 0 && <span className="home-org-elbow" aria-hidden="true" />}
        <OrgTile organization={organization} />
        <span className="home-org-body">
          <strong>{organization.name}</strong>
          <small>
            {organization.slug} · {source.kind === 'inherited' ? 'inherited role' : 'own role'}
          </small>
        </span>
        <RoleChip role={organization.effective_role} title={source.text} />
      </Link>
      {node.children.length > 0 && (
        <ul className="home-org-children">
          {node.children.map(child => (
            <OrgBranch key={child.organization.id} node={child} all={all} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** How many compositions the home lists. */
const COMPOSITIONS_SHOWN = 5;

/**
 * The compositions of one organization (the one last visited, else the first) changed most recently: five active ones, each
 * linking to its page, and the way to all of them.
 */
function CompositionsBlock({ organization }: { organization: Organization | undefined }) {
  const org = organization?.slug;
  const compositions = useResource(`home-compositions:${org ?? ''}`, () =>
    org
      ? compositionsApi.list(org, { archived: false, sort: 'updated', limit: COMPOSITIONS_SHOWN })
      : Promise.resolve(null)
  );
  const failure = compositions.status === 'error' ? classifyAuthError(compositions.error) : null;
  const items = compositions.data?.compositions ?? [];
  const canCreate = organization ? atLeast(organization.effective_role, 'MEMBER') : false;
  return (
    <section
      className="apphome-card"
      aria-labelledby="home-compositions-title"
      aria-busy={compositions.status === 'loading'}
    >
      <header className="home-card-head">
        <h2 id="home-compositions-title">Recent compositions</h2>
        {org && (
          <Link
            to={compositionsPath(org)}
            viewTransition
            aria-label={`All compositions of ${organization?.name ?? org}`}
          >
            All compositions
          </Link>
        )}
      </header>
      {compositions.status === 'loading' && (
        <div className="home-skeleton" role="status">
          <span className="sr-only">Loading recent compositions…</span>
          <Skeleton variant="tile" />
          <Skeleton variant="tile" />
        </div>
      )}
      {failure && isForbidden(failure) && (
        <p className="home-blocked">
          Not available with this key (needs <code>compositions:read</code>).
        </p>
      )}
      {failure && !isForbidden(failure) && (
        <div className="home-pad">
          <Notice
            tone="error"
            action={
              <Action variant="secondary" size="sm" onClick={compositions.reload}>
                Retry
              </Action>
            }
          >
            Recent compositions couldn’t be loaded{marker(failure)}. The other blocks are
            unaffected.
          </Notice>
        </div>
      )}
      {compositions.status === 'ready' && items.length === 0 && (
        <div className="home-guide">
          <strong>
            {org ? `No compositions in ${organization?.name ?? org} yet.` : 'No compositions yet.'}
          </strong>
          <span className="home-muted">
            A composition is the binding you keep: the service chosen for each task of a workflow,
            and the values that choice yields.
            {org && canCreate && (
              <>
                {' '}
                <Link to={`${compositionsPath(org)}?create=composition`}>
                  Write one in Composition2Yaml
                </Link>
                , or derive one from a run.
              </>
            )}
          </span>
        </div>
      )}
      {items.length > 0 && org && (
        <ul className="home-activity">
          {items.map(composition => (
            <li key={composition.id}>
              <Link
                to={compositionPath(org, composition.slug)}
                viewTransition
                className="home-activity-row"
              >
                <span className="home-activity-body">
                  <strong>{composition.name}</strong>
                  <small>
                    {composition.latest_version
                      ? `version ${composition.latest_version.label}`
                      : 'no version yet'}
                    {` · updated ${formatDate(composition.updated_at) ?? '—'}`}
                  </small>
                </span>
                {composition.latest_version && (
                  <ValueBadge status={valueStatus(composition.latest_version)} />
                )}
                <span className="home-status">{kindLabel(composition.kind)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The recent runs of one organization (the one last visited, else the first): five, newest first, each linking to its page. */
function ActivityBlock({ organization }: { organization: Organization | undefined }) {
  const org = organization?.slug;
  const jobs = useResource(`home-activity:${org ?? ''}`, () =>
    org ? runsApi.list(org, { limit: 5 }) : Promise.resolve({ runs: [], total: 0 })
  );
  const failure = jobs.status === 'error' ? classifyAuthError(jobs.error) : null;
  const items = jobs.data?.runs ?? [];
  return (
    <section
      className="apphome-card"
      aria-labelledby="home-activity-title"
      aria-busy={jobs.status === 'loading'}
    >
      <header className="home-card-head">
        <h2 id="home-activity-title">Recent activity</h2>
        {org && items.length > 0 && (
          <Link
            to={runsPath(org)}
            viewTransition
            aria-label={`All runs of ${organization?.name ?? org}`}
          >
            All runs
          </Link>
        )}
      </header>
      {jobs.status === 'loading' && (
        <div className="home-skeleton" role="status">
          <span className="sr-only">Loading recent runs…</span>
          <Skeleton variant="tile" />
          <Skeleton variant="tile" />
          <Skeleton variant="tile" />
        </div>
      )}
      {failure && isForbidden(failure) && (
        <p className="home-blocked">
          Not available with this key (needs <code>jobs:read</code>).
        </p>
      )}
      {failure && !isForbidden(failure) && (
        <div className="home-pad">
          <Notice
            tone="error"
            action={
              <Action variant="secondary" size="sm" onClick={jobs.reload}>
                Retry
              </Action>
            }
          >
            Recent runs couldn’t be loaded{marker(failure)}. The other blocks are unaffected.
          </Notice>
        </div>
      )}
      {jobs.status === 'ready' && items.length === 0 && (
        <div className="home-guide">
          <strong>No runs yet. Here’s a way to your first run.</strong>
          <ol>
            <li>
              {org ? (
                <>
                  <Link to={`${problemsPath(org)}?create=problem`}>Upload a BIM package</Link> as a
                  problem of {organization?.name ?? org}, or write one in its{' '}
                  <Link to={problemEditorPath(org)}>problem editor</Link>.
                </>
              ) : (
                <>
                  Create an organization, then upload a BIM package as one of its problems.{' '}
                  <Link to="/workbench">Check a package</Link> first if you like.
                </>
              )}
            </li>
            <li>Launch a run of it; it appears here while it works.</li>
          </ol>
        </div>
      )}
      {items.length > 0 && (
        <ul className="home-activity">
          {items.map(job => {
            const status = jobStatus(job);
            return (
              <li key={job.id}>
                <Link
                  to={runPath(org ?? job.organization_id, job.id)}
                  viewTransition
                  className="home-activity-row"
                >
                  <span className={`home-dot is-${status.tone}`} aria-hidden="true" />
                  <span className="home-activity-body">
                    <strong>{job.problem?.name ?? job.engine_id}</strong>
                    <small>{jobMeta(job)}</small>
                  </span>
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
    { id: LIMIT.maxConcurrentRuns, label: 'Runs at once', format: formatCount },
    { id: LIMIT.maxApiKeys, label: 'API keys', format: formatCount },
  ];
  return (
    <section
      className="apphome-card is-padded"
      aria-labelledby="home-plan-title"
      aria-busy={usage.status === 'loading'}
    >
      <header className="home-card-head is-bare">
        <h2 id="home-plan-title">Your plan</h2>
        <Link to="/app/account/usage" viewTransition>
          Plan
        </Link>
      </header>
      {usage.status === 'loading' && <Skeleton variant="panel" />}
      {failure && isForbidden(failure) && (
        <p className="home-blocked">Not available with this key (needs account: read).</p>
      )}
      {failure && !isForbidden(failure) && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={usage.reload}>
              Retry
            </Action>
          }
        >
          {failure.code === 'pricing_unavailable' || failure.kind === 'unavailable'
            ? `Your plan can’t be loaded right now${marker(failure)}. Nothing else on this page depends on it.`
            : generalFailure(failure, 'no plan is shown')}
        </Notice>
      )}
      {data?.contract_pending && (
        <Notice tone="warning">
          Your plan is still being settled (contract pending). Limits appear here once it’s
          confirmed.
        </Notice>
      )}
      {data && !data.contract_pending && (
        <>
          <div className="home-untracked">
            <span>Plan</span>
            <strong>{data.plan || NO_PLAN_TEXT}</strong>
          </div>
          {picks.map(pick => {
            const row = rows.find(item => item.id === pick.id);
            if (!row) return null;
            return (
              <div key={pick.id} className="home-untracked">
                <span>{pick.label}</span>
                <strong>
                  {row.limit === null ? 'Unlimited' : `Up to ${pick.format(row.limit)}`}
                </strong>
              </div>
            );
          })}
        </>
      )}
      <span className="home-muted">
        Plans and contracts are managed in the native consoles:{' '}
        <a href={config.spaceFrontendUrl} target="_blank" rel="noopener noreferrer">
          SPACE
        </a>
        {' · '}
        <a href={config.sphereUrl} target="_blank" rel="noopener noreferrer">
          SPHERE
        </a>
        .
      </span>
    </section>
  );
}

function NotificationsBlock({ announce }: { announce: (text: string) => void }) {
  const unread = useResource('home-notifications', () => apiClient.listNotifications(true));
  const failure = unread.status === 'error' ? classifyAuthError(unread.error) : null;
  const [reading, setReading] = useState('');
  const items = (unread.data ?? []).filter(item => !item.read_at);

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
    <section
      className="apphome-card is-padded"
      aria-labelledby="home-notifications-title"
      aria-busy={unread.status === 'loading'}
    >
      <header className="home-card-head is-bare">
        <h2 id="home-notifications-title">Unread notifications</h2>
        <Link to="/app/account/notifications" viewTransition>
          All
        </Link>
      </header>
      {unread.status === 'loading' && <Skeleton variant="tile" />}
      {failure && isForbidden(failure) && (
        <p className="home-blocked">Not available with this key (needs notifications: read).</p>
      )}
      {failure && !isForbidden(failure) && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={unread.reload}>
              Retry
            </Action>
          }
        >
          Notifications couldn’t be loaded{marker(failure)}.
        </Notice>
      )}
      {unread.status === 'ready' && items.length === 0 && (
        <span className="home-muted">You’re all caught up.</span>
      )}
      {items.slice(0, 3).map(item => {
        const change = contractChange(item);
        return (
          <div key={item.id} className="home-notification">
            <strong>{item.subject}</strong>
            <span className="home-notification-line">
              {change && (
                <>
                  <Chip>{change.before.plan}</Chip>
                  <span aria-hidden="true">→</span>
                  <Chip tone="accent">{change.after.plan}</Chip>
                </>
              )}
              <span className="home-muted">
                {change ? '· ' : ''}
                {formatDate(item.created_at) ?? item.created_at}
              </span>
            </span>
            <button
              type="button"
              className="home-link-button"
              disabled={reading === item.id}
              onClick={() => void markRead(item)}
            >
              Mark as read
            </button>
          </div>
        );
      })}
      {items.length > 3 && (
        <Link to="/app/account/notifications" viewTransition className="home-more">
          {items.length - 3} more unread
        </Link>
      )}
    </section>
  );
}

/** Home (`app-home`, `/app`): the organizations you can reach, recent compositions and runs, your plan and unread notices. */
export function AppHome() {
  const context = useOutletContext<PlatformOutletContext>();
  const { user, isAdmin } = useAuth();
  const location = useLocation();
  const [announcement, setAnnouncement] = useState('');
  const deleted = (location.state as { deletedOrganization?: string } | null)?.deletedOrganization;

  const orgs = useResource('home-organizations', () => platformApi.organizations());
  const failure = orgs.status === 'error' ? classifyAuthError(orgs.error) : null;
  const list: Organization[] = orgs.data ?? [];
  const forest = buildForest(list);
  const empty = orgs.status === 'ready' && list.length === 0;
  // The organization the recent blocks are about: the one last visited, else the first.
  const current = list.find(item => item.slug === lastOrganization()) ?? list[0];

  const organization = context.organization ?? list[0];
  const shortcuts: Shortcut[] = [];
  if (organization) {
    shortcuts.push({
      label: 'New composition',
      to: `${compositionsPath(organization.slug)}?create=composition`,
      icon: Layers,
    });
    shortcuts.push({
      label: 'New problem',
      to: `${problemsPath(organization.slug)}?create=problem`,
      icon: FilePlus2,
    });
  }
  if (organization) shortcuts.push({ label: 'Run', to: launchPath(organization.slug), icon: Play });

  const subtitle = isAdmin
    ? 'You’re a platform administrator. Admin tools are in the header.'
    : list.length > 0
      ? 'Pick up where you left off.'
      : 'Let’s set up a place for your work.';

  return (
    <div className="apphome-page">
      <div className="home-head">
        <div>
          <h1>Hello, {user?.username ?? 'there'}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="home-shortcuts">
          <Link to="/orgs/new" viewTransition>
            <Building2 aria-hidden="true" />
            New organization
          </Link>
          {shortcuts.map(({ label, to, icon: Icon }) => (
            <Link key={label} to={to} viewTransition>
              <Icon aria-hidden="true" />
              {label}
            </Link>
          ))}
        </div>
      </div>

      {deleted && (
        <Notice tone="success">{deleted} was deleted, together with everything inside it.</Notice>
      )}

      {empty && (
        <section className="home-first" aria-labelledby="home-first-title">
          <div className="home-first-art" aria-hidden="true">
            <span className="is-root" />
            <span className="is-line" />
            <span className="is-pair">
              <i />
              <i />
            </span>
          </div>
          <div className="home-first-body">
            <h2 id="home-first-title">Create your first organization</h2>
            <span>
              An organization holds your compositions, the problems they are chosen from, runs and
              studies, and the people who work on them. You can nest them: a lab inside a group
              inherits the group’s roles.
            </span>
            <span className="home-first-actions">
              <Action to="/orgs/new" variant="primary">
                Create organization
              </Action>
              <Link to="/invitations/accept">I have an invitation</Link>
            </span>
          </div>
        </section>
      )}

      <div className="home-columns">
        <section
          className="apphome-card home-orgs"
          aria-labelledby="home-orgs-title"
          aria-busy={orgs.status === 'loading'}
        >
          <header className="home-card-head">
            <h2 id="home-orgs-title">Your organizations</h2>
            <Link to="/orgs/new" viewTransition>
              + New
            </Link>
          </header>
          {orgs.status === 'loading' && (
            <div className="home-skeleton" role="status">
              <span className="sr-only">Loading organizations…</span>
              <Skeleton variant="tile" />
              <Skeleton variant="tile" />
              <Skeleton variant="tile" />
            </div>
          )}
          {failure && isForbidden(failure) && (
            <p className="home-blocked">Not available with this key (needs organizations: read).</p>
          )}
          {failure && !isForbidden(failure) && (
            <div className="home-pad">
              <Notice
                tone="error"
                action={
                  <Action variant="secondary" size="sm" onClick={orgs.reload}>
                    Retry
                  </Action>
                }
              >
                Your organizations couldn’t be loaded{marker(failure)}. The other blocks are
                unaffected.
              </Notice>
            </div>
          )}
          {empty && (
            <p className="home-blocked">
              {isAdmin
                ? 'You aren’t a member of any organization yet.'
                : 'You’re not in any organization yet.'}
            </p>
          )}
          {forest.length > 0 && (
            <>
              <ul className="home-org-tree" aria-label="Organizations">
                {forest.map(node => (
                  <OrgBranch key={node.organization.id} node={node} all={list} />
                ))}
              </ul>
              <p className="home-card-foot">
                Your role in a sub-organization is the highest of your own role there and the one
                inherited from above.
              </p>
            </>
          )}
        </section>

        <div className="home-side">
          <CompositionsBlock organization={current} />
          <ActivityBlock organization={current} />
          <div className="home-pair">
            <PlanBlock />
            <NotificationsBlock announce={setAnnouncement} />
          </div>
        </div>
      </div>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
