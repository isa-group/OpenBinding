import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { UsageView } from '../../api/auth';
import { platformApi } from '../../api/platform';
import type { Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ancestorsOf, atLeast, byName, roleSource, sponsorName } from './orgModel';
import { classifyAuthError, generalFailure, marker } from './orgErrors';
import { Breadcrumb, NeutralGate, OrgTile, PageSkeleton, RoleChip } from './parts';
import { RoomBars } from './room';
import { ROOM_IDS, roomFromUsage } from './roomModel';
import { useRouteOrganization } from './useRouteOrganization';
import './Organization.css';

interface RoomData {
  usage: UsageView | null;
  failure: ReturnType<typeof classifyAuthError> | null;
}

function ProjectCard({ organization, project }: { organization: Organization; project: Project }) {
  const isPublic = project.visibility === 'public';
  return (
    <Link to={`/app/${organization.slug}/${project.slug}`} viewTransition className="org-project-card">
      <span className="org-project-head">
        <strong>{project.name}</strong>
        <Chip tone={isPublic ? 'success' : 'plain'}>{isPublic ? 'Public' : 'Private'}</Chip>
      </span>
      <span className="org-project-desc">{project.description || 'No description yet.'}</span>
      <span className="org-project-meta">
        <code>{project.slug}</code>
        <span>Created {formatDate(project.created_at) ?? '—'}</span>
        {project.updated_at !== project.created_at && <span>Updated {formatDate(project.updated_at) ?? '—'}</span>}
      </span>
    </Link>
  );
}

function OrgOverviewBody({ organization }: { organization: Organization }) {
  const { context } = useRouteOrganization();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const slug = organization.slug;
  const role = organization.effective_role;
  const source = roleSource(organization, context.organizations);
  const canCreate = atLeast(role, 'MEMBER');
  const canAdminister = atLeast(role, 'ADMIN');
  const sponsorIsMe = user?.id === organization.billing_sponsor_user_id;

  const projects = useResource(`org-projects:${slug}`, () => platformApi.projects(slug));
  const people = useResource(`org-people:${slug}`, () => platformApi.members(slug).catch(() => []));
  const room = useResource<RoomData>(`org-room:${slug}:${sponsorIsMe}`, async () => {
    if (!sponsorIsMe) return { usage: null, failure: null };
    try {
      return { usage: await apiClient.getOwnUsage(), failure: null };
    } catch (caught) {
      return { usage: null, failure: classifyAuthError(caught) };
    }
  });

  const me = user ? { id: user.id, username: user.username } : null;
  const sponsor = sponsorName(organization, people.data ?? [], me);
  const ancestors = ancestorsOf(organization, context.organizations).reverse();
  const subs = context.organizations.filter((item) => item.parent_id === organization.id).sort(byName);

  const all = projects.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = all.filter((item) => !needle || `${item.name} ${item.slug}`.toLowerCase().includes(needle));
  const failure = projects.status === 'error' ? classifyAuthError(projects.error) : null;

  const roomRows = room.data?.usage ? roomFromUsage(room.data.usage, ROOM_IDS) : [];

  return (
    <div className="org-page is-wide">
      <div className="org-topline">
        <Breadcrumb items={[
          { label: 'Home', to: '/app' },
          ...ancestors.map((item) => ({ label: item.name, to: `/app/${item.slug}` })),
          { label: organization.name },
        ]} />
        {context.organizations.length > 1 && (
          <label className="org-switch">
            Switch organization
            <select value={slug} onChange={(event) => navigate(`/app/${event.target.value}`)}>
              {context.organizations.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
        )}
      </div>

      <header className="org-hero">
        <OrgTile organization={organization} size="lg" />
        <div className="org-hero-body">
          <h1>{organization.name}</h1>
          <span className="org-hero-line">
            <code>/app/{slug}</code>
            <RoleChip role={role} title={source.text} />
            <small>{source.text}</small>
          </span>
          <span className="org-hero-sponsor">
            Sponsored by <strong>{sponsor}</strong> · created {formatDate(organization.created_at) ?? '—'}
          </span>
        </div>
        <div className="org-hero-actions">
          {canCreate && <Action to={`/app/${slug}/new-project`} variant="primary">New project</Action>}
          <Action to={`/app/${slug}/library`} variant="secondary">Library</Action>
          <Action to={`/app/${slug}/settings/members`} variant="secondary">Members</Action>
          {canAdminister && <Action to={`/app/${slug}/settings/audit`} variant="secondary">Audit</Action>}
          <Action to={`/app/${slug}/settings`} variant="secondary">Settings</Action>
        </div>
      </header>

      <div className="org-columns">
        <section className="org-main" aria-labelledby="org-projects-title" aria-busy={projects.status === 'loading'}>
          <div className="org-section-head">
            <h2 id="org-projects-title">Projects{projects.status === 'ready' && <span className="org-count">{all.length}</span>}</h2>
            <label className="org-find">
              <span className="sr-only">Find a project</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a project…" />
            </label>
          </div>

          {projects.status === 'loading' && (
            <div className="org-project-grid" role="status"><span className="sr-only">Loading projects…</span><Skeleton variant="card" /><Skeleton variant="card" /></div>
          )}

          {failure && (
            <Notice
              tone="error"
              action={<Action variant="secondary" size="sm" onClick={projects.reload}>Retry</Action>}
            >
              {failure.status === 403
                ? `You can’t list the projects of this organization (403). Sub-organizations and usage are unaffected.`
                : `Projects couldn’t be loaded${marker(failure)}. Sub-organizations and usage are unaffected.`}
            </Notice>
          )}

          {projects.status === 'ready' && all.length === 0 && (
            <div className="org-empty">
              <strong>No projects yet</strong>
              <span>
                A project groups the cases, runs, studies and reports for one piece of work. Public projects can be found in Explore;
                private ones are only for members.
              </span>
              {canCreate && <Action to={`/app/${slug}/new-project`} variant="primary" size="sm">Create the first project</Action>}
              {role === 'VIEWER' && (
                <small>You’re a VIEWER here, so you can’t create projects. A MEMBER or above can.</small>
              )}
            </div>
          )}

          {projects.status === 'ready' && all.length > 0 && shown.length === 0 && (
            <p className="org-muted">No project matches “{query.trim()}”.</p>
          )}

          {shown.length > 0 && (
            <div className="org-project-grid">
              {shown.map((item) => <ProjectCard key={item.id} organization={organization} project={item} />)}
            </div>
          )}
        </section>

        <aside className="org-aside">
          <section className="org-card" aria-labelledby="org-subs-title">
            <div className="org-card-head">
              <h2 id="org-subs-title">Sub-organizations</h2>
              {canAdminister && <Link to="/app/organizations/new" viewTransition>+ Add</Link>}
            </div>
            {subs.length === 0 && <span className="org-muted">None. Sub-organizations inherit everyone’s role from here.</span>}
            {subs.map((item) => {
              const itemSource = roleSource(item, context.organizations);
              return (
                <Link key={item.id} to={`/app/${item.slug}`} viewTransition className="org-sub">
                  <OrgTile organization={item} size="sm" />
                  <span><strong>{item.name}</strong><small>{itemSource.text}</small></span>
                  <RoleChip role={item.effective_role} title={itemSource.text} />
                </Link>
              );
            })}
          </section>

          <section className="org-card" aria-labelledby="org-room-title">
            <h2 id="org-room-title">Sponsor’s room</h2>
            <span className="org-muted">Size limits come from the sponsor’s plan, not from your own.</span>
            {room.status === 'loading' && <Skeleton variant="panel" />}
            {room.data?.failure && (
              <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={room.reload}>Retry</Action>}>
                {room.data.failure.kind === 'unavailable'
                  ? `Your plan limits can’t be loaded right now${marker(room.data.failure)}. Nothing else on this page depends on them.`
                  : generalFailure(room.data.failure, 'no limits are shown')}
              </Notice>
            )}
            {room.status === 'ready' && !sponsorIsMe && (
              <div className="org-note-dashed">
                {sponsor}’s plan is visible only to them. Their plan sets this organization’s limits, and the server refuses (402) anything that would go past them.
              </div>
            )}
            {roomRows.length > 0 && (
              <>
                <RoomBars rows={roomRows} />
                <span className="org-muted">Counted across every organization {sponsorIsMe ? 'you sponsor' : `${sponsor} sponsors`}.</span>
              </>
            )}
            {room.data?.usage?.contract_pending && (
              <Notice tone="warning">Your plan is still being settled (contract pending). Limits appear here once it’s confirmed.</Notice>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** An organization (`org-overview`, `/app/:org`): its projects, sub-organizations and the sponsor’s room. */
export function OrgOverview() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <div className="org-page"><PageSkeleton /></div>;
  if (!organization) return <div className="org-page"><NeutralGate withExplore /></div>;
  return <OrgOverviewBody organization={organization} />;
}
