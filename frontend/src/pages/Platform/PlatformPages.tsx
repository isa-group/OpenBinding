import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Archive, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Braces, CheckCircle2, CircleDashed, CircleStop, Clock3, Copy, Database, ExternalLink, Eye, FileArchive, FileText, FlaskConical,
  FolderKanban, GitCompareArrows, Globe2, History, Layers3, Library, LockKeyhole, Network, Plus,
  RefreshCw, Rocket, ShieldCheck, Sparkles, Trash2, TriangleAlert, UserRoundPlus, Users,
} from 'lucide-react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { platformApi } from '../../api/platform';
import { apiClient, bimResourceKey } from '../../api/client';
import type { EngineCatalogEntry } from '../../api/client';
import type {
  Analytics, Artifact, BindingCase, CaseRevision, Collection, CollectionItem,
  CollectionRevision, OrganizationInvitation, OrganizationMember, OrganizationRole,
  ProjectResource, ProjectResourceRevision, Publication, Report, Study, StudyCell, StudyRun,
} from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { EntityDrawer } from '../../components/Inspection/EntityDrawer';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { parseBindingSpace, toSuperscript } from '../../components/BindingSpaceBadge/bindingSpace';
import '../../components/Inspection/VisualEffects.css';
import './PlatformPages.css';

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="observatory-empty"><CircleDashed aria-hidden="true" /><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function PageHeading({ eyebrow, title, detail, action }: {
  eyebrow: string; title: string; detail: string; action?: ReactNode;
}) {
  return <header className="platform-page-heading"><div><span>{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div>{action}</header>;
}

export function PlatformDashboard() {
  const context = useOutletContext<PlatformOutletContext>();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createOrganization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError(null);
    try {
      const org = await platformApi.createOrganization({
        name: String(form.get('name')), slug: String(form.get('slug')),
        parent_id: String(form.get('parent') || '') || null,
      });
      const projName = String(form.get('project_name') || '').trim();
      let projSlug = String(form.get('project_slug') || '').trim();
      if (projName && !projSlug) {
        projSlug = projName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      }
      if (projName && projSlug) {
        await platformApi.createProject(org.slug, {
          name: projName,
          slug: projSlug,
          description: String(form.get('project_desc') || ''),
          visibility: 'private',
        });
        await context.reload();
        navigate(`/app/${org.slug}/${projSlug}`);
      } else {
        await context.reload();
        navigate(`/app/${org.slug}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The organization could not be created.');
    } finally { setCreating(false); }
  };

  return <div className="platform-page">
    <PageHeading eyebrow="Binding observatory" title="Your research workspace"
      detail="Organize immutable cases, run exact engine revisions and turn their results into reproducible evidence."
      action={<Link className="platform-primary-action" to={context.project ? `/app/${context.organization?.slug}/${context.project.slug}/workbench` : '/examples'}><Plus aria-hidden="true" />New analysis</Link>} />

    <section className="observatory-pulse" aria-label="Platform workflow">
      <div className="pulse-copy"><span>Live model</span><h2>From binding question to citable result.</h2><p>The same pinned package moves through validation, compilation, execution, reevaluation and publication.</p></div>
      <svg viewBox="0 0 720 250" role="img" aria-label="Animated binding analysis topology">
        <defs><linearGradient id="pulse-line"><stop stopColor="var(--color-accent)"/><stop offset="1" stopColor="var(--color-dialect)"/></linearGradient></defs>
        <path className="pulse-path" d="M62 126 C160 30 220 218 318 126 S480 30 658 126" />
        {[62, 190, 318, 470, 658].map((x, index) => <g key={x} className={`pulse-node pulse-node-${index}`}><circle cx={x} cy={index % 2 ? 95 : 126} r="18"/><circle cx={x} cy={index % 2 ? 95 : 126} r="5"/></g>)}
        <text x="42" y="174">CASE</text><text x="280" y="174">ENGINE</text><text x="620" y="174">REPORT</text>
      </svg>
    </section>

    {context.organizations.length === 0 ? (
      <section className="platform-onboarding-card">
        <div className="onboarding-header">
          <Sparkles aria-hidden="true" />
          <div>
            <h3>Welcome to OpenBinding! Let&apos;s set up your workspace</h3>
            <p>
              When you create an account, you start with a clean slate. OpenBinding structures research hierarchically:
              Organizations group members and sponsor resources, while Projects contain your cases, studies, and reproducible evidence.
            </p>
          </div>
        </div>

        <div className="onboarding-concepts">
          <div className="concept-box">
            <h3><Users aria-hidden="true" /> Organizations</h3>
            <p>
              Your research lab, institution, team, or personal umbrella. Organizations own billing, invite members, and isolate project access.
            </p>
          </div>
          <div className="concept-box">
            <h3><FolderKanban aria-hidden="true" /> Projects</h3>
            <p>
              Versioned workspaces within an organization. Each project holds binding cases, datasets, comparative matrices, and published reports.
            </p>
          </div>
        </div>

        <form className="onboarding-form" onSubmit={createOrganization}>
          <h3>Create your first organization &amp; project</h3>
          <div className="onboarding-form-grid">
            <label>
              Organization Name
              <input name="name" required minLength={1} maxLength={160} placeholder="e.g. Seville Binding Lab" />
            </label>
            <label>
              Organization Slug
              <input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="e.g. seville-binding-lab" />
            </label>
            <label>
              Initial Project Name (optional)
              <input name="project_name" placeholder="e.g. Benchmark Studies" />
            </label>
            <label>
              Initial Project Slug (optional)
              <input name="project_slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="e.g. benchmark-studies" />
            </label>
          </div>
          {error && <p className="platform-form-error" role="alert">{error}</p>}
          <div className="onboarding-form-actions">
            <button className="platform-primary-action" type="submit" disabled={creating}>
              <Plus aria-hidden="true" /> {creating ? 'Setting up workspace…' : 'Create Organization & Get Started'}
            </button>
          </div>
        </form>
      </section>
    ) : (
      <>
        <section className="platform-section">
          <div className="section-title"><div><span>Organizations</span><h2>Spaces you can reach</h2></div><small>{context.organizations.length} visible</small></div>
          <div className="workspace-card-grid">{context.organizations.map((organization) => {
            const projects = organization.id === context.organization?.id ? context.projects : [];
            return <article key={organization.id} className="workspace-card">
              <header><span>{organization.name.slice(0, 2).toUpperCase()}</span><small>{organization.effective_role}</small></header>
              <h3>{organization.name}</h3><code>{organization.slug}</code>
              <div>{projects.slice(0, 3).map((project) => <Link key={project.id} to={`/app/${organization.slug}/${project.slug}`}><FolderKanban aria-hidden="true" /><span>{project.name}<small>{project.visibility}</small></span><ArrowRight aria-hidden="true" /></Link>)}</div>
              <Link className="card-footer-link" to={`/app/${organization.slug}`}>Open organization <ArrowRight aria-hidden="true" /></Link>
            </article>;
          })}</div>
        </section>

        <details className="inline-create-panel">
          <summary><Plus aria-hidden="true" /> Create organization</summary>
          <form onSubmit={createOrganization}>
            <label>Name<input name="name" required minLength={1} maxLength={160} placeholder="Service Composition Lab" /></label>
            <label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="service-composition-lab" /></label>
            <label>Parent<select name="parent" defaultValue=""><option value="">Root organization</option>{context.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label>
            {error && <p role="alert">{error}</p>}
            <button disabled={creating}>{creating ? 'Creating…' : 'Create organization'}</button>
          </form>
        </details>
      </>
    )}
  </div>;
}

export function OrganizationSettingsPage() {
  const context = useOutletContext<PlatformOutletContext>();
  const navigate = useNavigate();
  const organization = context.organization;
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invitation, setInvitation] = useState<OrganizationInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const editable = organization?.effective_role === 'OWNER' || organization?.effective_role === 'ADMIN';
  const load = useCallback(async () => {
    if (!organization) return;
    try { setMembers(await platformApi.members(organization.slug)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Members could not be loaded.'); }
  }, [organization]);
  useEffect(() => { void load(); }, [load]);

  if (!organization) return <div className="platform-page"><Empty title="No organization selected" detail="Create or select an organization before managing collaboration." /></div>;

  const move = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parent = String(form.get('parent') || '');
    setBusy('organization'); setError(null);
    try {
      await platformApi.updateOrganization(organization.slug, {
        name: String(form.get('name')),
        ...(parent ? { parent_id: parent } : { move_to_root: true }),
      });
      await context.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Organization update failed.'); }
    finally { setBusy(null); }
  };

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy('invite'); setError(null); setInvitation(null);
    try {
      setInvitation(await platformApi.inviteMember(organization.slug, {
        email: String(form.get('email')),
        role: String(form.get('role')) as OrganizationRole,
      }));
      event.currentTarget.reset();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Invitation could not be created.'); }
    finally { setBusy(null); }
  };

  const changeRole = async (member: OrganizationMember, role: OrganizationRole) => {
    setBusy(member.id); setError(null);
    try { await platformApi.updateMember(organization.slug, member.user_id, role); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Member role could not be changed.'); }
    finally { setBusy(null); }
  };

  const remove = async (member: OrganizationMember) => {
    if (!window.confirm(`Remove ${member.username ?? member.email ?? member.user_id} from ${organization.name}? Their active API keys will be revoked.`)) return;
    setBusy(member.id); setError(null);
    try { await platformApi.removeMember(organization.slug, member.user_id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Member could not be removed.'); }
    finally { setBusy(null); }
  };

  return <div className="platform-page organization-settings-page">
    <PageHeading eyebrow="Collaboration boundary" title={organization.name} detail="Manage the explicit membership at this node. Roles inherited from ancestors remain effective in descendants; this screen never creates a deny rule." />
    {error && <p className="platform-form-error" role="alert">{error}</p>}
    <div className="organization-settings-grid">
      <section className="organization-identity-card">
        <span>Organization identity</span><h2>{organization.slug}</h2>
        <dl><dt>Your effective role</dt><dd>{organization.effective_role}</dd><dt>Sponsor</dt><dd><code>{organization.billing_sponsor_user_id}</code></dd><dt>Parent</dt><dd>{context.organizations.find((item) => item.id === organization.parent_id)?.name ?? 'Root'}</dd></dl>
        {editable && <form onSubmit={move}><label>Name<input name="name" defaultValue={organization.name} required /></label><label>Parent<select name="parent" defaultValue={organization.parent_id ?? ''}><option value="">Root organization</option>{context.organizations.filter((item) => item.id !== organization.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button disabled={busy === 'organization'}>{busy === 'organization' ? 'Saving…' : 'Save organization'}</button></form>}
      </section>
      <section className="member-panel">
        <header><div><span>Direct membership</span><h2><Users aria-hidden="true" /> {members.length} members</h2></div><small>Inherited access is evaluated separately</small></header>
        <div className="member-ledger">{members.map((member) => <article key={member.id}><div className="member-avatar" aria-hidden="true">{(member.username ?? member.email ?? 'U').slice(0, 2).toUpperCase()}</div><div><strong>{member.username ?? member.email ?? member.user_id}</strong><small>{member.email ?? member.user_id}</small></div><select aria-label={`Role for ${member.username ?? member.user_id}`} value={member.role} disabled={!editable || busy === member.id} onChange={(event) => void changeRole(member, event.target.value as OrganizationRole)}>{(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const).map((role) => <option key={role}>{role}</option>)}</select>{editable && <button className="member-remove" type="button" disabled={busy === member.id} onClick={() => void remove(member)}>Remove</button>}</article>)}</div>
        {!members.length && <Empty title="No direct members" detail="Access may still be inherited from a parent organization." />}
      </section>
    </div>
    {editable && <section className="invitation-panel"><header><UserRoundPlus aria-hidden="true" /><div><span>One-time invitation</span><h2>Invite a collaborator</h2><p>The token is shown once, expires after seven days and only works for the invited email address.</p></div></header><form onSubmit={invite}><label>Email<input name="email" type="email" required /></label><label>Role<select name="role" defaultValue="MEMBER">{(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const).map((role) => <option key={role}>{role}</option>)}</select></label><button disabled={busy === 'invite'}>{busy === 'invite' ? 'Creating…' : 'Create invitation'}</button></form>{invitation && <div className="invitation-secret" role="status"><div><strong>Invitation for {invitation.email}</strong><small>Expires {new Date(invitation.expires_at).toLocaleString()}</small></div><code>{invitation.token}</code><button type="button" onClick={() => void navigator.clipboard.writeText(invitation.token)}><Copy aria-hidden="true" /> Copy token</button></div>}</section>}
    {editable && (
      <section className="danger-zone-section" aria-labelledby="org-danger-zone-title">
        <div className="danger-zone-header">
          <TriangleAlert aria-hidden="true" />
          <h2 id="org-danger-zone-title">Danger Zone</h2>
        </div>
        <p className="danger-zone-desc">
          Deleting an organization permanently removes all descendant organizations, projects, cases, studies, reports, and member associations. This action cannot be undone.
        </p>
        <div className="danger-zone-actions">
          <button
            type="button"
            className="btn-danger"
            disabled={busy === 'delete-org'}
            onClick={async () => {
              if (!window.confirm(`Are you sure you want to permanently delete "${organization.name}" (${organization.slug}) and all associated projects? This cannot be undone.`)) {
                return;
              }
              const confirmation = window.prompt(`Type "${organization.slug}" to confirm deletion:`);
              if (confirmation !== organization.slug) {
                alert('Organization slug does not match. Deletion cancelled.');
                return;
              }
              setBusy('delete-org');
              setError(null);
              try {
                await platformApi.deleteOrganization(organization.slug);
                await context.reload();
                navigate('/app');
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Failed to delete organization.');
                setBusy(null);
              }
            }}
          >
            <TriangleAlert aria-hidden="true" />
            {busy === 'delete-org' ? 'Deleting organization…' : 'Delete this organization'}
          </button>
        </div>
      </section>
    )}
  </div>;
}

export function ProjectOverview() {
  const context = useOutletContext<PlatformOutletContext>();
  const navigate = useNavigate();
  const { organization, project } = context;
  const [cases, setCases] = useState<BindingCase[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!organization || !project) return;
    void Promise.all([
      platformApi.cases(organization.slug, project.slug),
      platformApi.studies(organization.slug, project.slug),
      platformApi.reports(organization.slug, project.slug),
    ]).then(([nextCases, nextStudies, nextReports]) => {
      setCases(nextCases); setStudies(nextStudies); setReports(nextReports);
    });
  }, [organization, project]);

  if (!organization || !project) return <NoProject />;
  const root = `/app/${organization.slug}/${project.slug}`;
  const canAdminister = organization.effective_role === 'OWNER' || organization.effective_role === 'ADMIN';
  const toggleVisibility = async () => {
    setVisibilityBusy(true); setVisibilityError(null);
    try {
      await platformApi.updateProject(organization.slug, project.slug, {
        visibility: project.visibility === 'public' ? 'private' : 'public',
      });
      await context.reload();
    } catch (caught) {
      setVisibilityError(caught instanceof Error ? caught.message : 'Project visibility could not be changed.');
    } finally { setVisibilityBusy(false); }
  };
  return <div className="platform-page">
    <PageHeading eyebrow={`${organization.name} / project`} title={project.name} detail={project.description || 'A versioned workspace for binding cases and evidence.'}
      action={<Link className="platform-primary-action" to={`${root}/workbench`}><Rocket aria-hidden="true" />Open workbench</Link>} />
    <div className="metric-ribbon">
      <article><small>Cases</small><strong>{cases.length}</strong><span>immutable problem histories</span></article>
      <article><small>Studies</small><strong>{studies.length}</strong><span>defined matrices</span></article>
      <article><small>Reports</small><strong>{reports.length}</strong><span>{reports.filter((item) => item.state === 'frozen').length} frozen</span></article>
      <article><small>Visibility</small><strong className="metric-word">{project.visibility}</strong><span>{project.visibility === 'public' ? 'discoverable in Explore' : 'members only'}</span></article>
    </div>
    {canAdminister && <section className="project-visibility-control"><div><Globe2 aria-hidden="true" /><span><strong>{project.visibility === 'public' ? 'Published in Explore' : 'Private collaboration'}</strong><small>{project.visibility === 'public' ? 'Immutable public revisions and reports can now be discovered.' : 'Only members and scoped API keys can read this project.'}</small></span></div><button type="button" disabled={visibilityBusy} onClick={() => void toggleVisibility()}>{visibilityBusy ? 'Updating…' : project.visibility === 'public' ? 'Make private' : 'Publish project'}</button>{visibilityError && <p role="alert">{visibilityError}</p>}</section>}
    <section className="project-flow">
      {[
        ['01', 'Model', 'Import BIM or BPMN and preserve the exact source snapshot.', Braces],
        ['02', 'Solve', 'Match compatible modes and dispatch durable, metered jobs.', Network],
        ['03', 'Compare', 'Expand cases × engines × parameters × seeds deterministically.', GitCompareArrows],
        ['04', 'Publish', 'Freeze provenance and expose immutable evidence by digest.', ShieldCheck],
      ].map(([index, title, copy, Icon]) => <article key={String(index)}><span>{String(index)}</span><Icon aria-hidden="true" /><h3>{String(title)}</h3><p>{String(copy)}</p></article>)}
    </section>
    <section className="platform-section compact"><div className="section-title"><div><span>Recent material</span><h2>Continue where the project left off</h2></div></div>
      <div className="recent-ledger">
        {cases.slice(0, 3).map((item) => <Link key={item.id} to={`${root}/cases`}><span className="ledger-kind">CASE</span><strong>{item.name}</strong><small>{item.description || item.slug}</small><ArrowRight aria-hidden="true" /></Link>)}
        {studies.slice(0, 3).map((item) => <Link key={item.id} to={`${root}/studies`}><span className="ledger-kind">STUDY</span><strong>{item.name}</strong><small>{item.definition.case_revision_ids.length} cases · {item.definition.engines.length} engines</small><ArrowRight aria-hidden="true" /></Link>)}
        {!cases.length && !studies.length && <Empty title="The project is empty" detail="Start in the workbench or create a binding case." action={<Link to={`${root}/workbench`}>Open workbench</Link>} />}
      </div>
    </section>
    {canAdminister && (
      <section className="danger-zone-section" aria-labelledby="proj-danger-zone-title">
        <div className="danger-zone-header">
          <TriangleAlert aria-hidden="true" />
          <h2 id="proj-danger-zone-title">Danger Zone</h2>
        </div>
        <p className="danger-zone-desc">
          Deleting this project permanently destroys all of its binding cases, study matrices, reports, artifacts, and execution histories. This action cannot be undone.
        </p>
        <div className="danger-zone-actions">
          <button
            type="button"
            className="btn-danger"
            disabled={deleteBusy}
            onClick={async () => {
              if (!window.confirm(`Are you sure you want to permanently delete project "${project.name}" (${project.slug})? All cases, studies, and artifacts will be permanently lost.`)) {
                return;
              }
              const confirmation = window.prompt(`Type "${project.slug}" to confirm deletion:`);
              if (confirmation !== project.slug) {
                alert('Project slug does not match. Deletion cancelled.');
                return;
              }
              setDeleteBusy(true);
              setDeleteError(null);
              try {
                await platformApi.deleteProject(organization.slug, project.slug);
                await context.reload();
                navigate(`/app/${organization.slug}`);
              } catch (caught) {
                setDeleteError(caught instanceof Error ? caught.message : 'Failed to delete project.');
                setDeleteBusy(false);
              }
            }}
          >
            <TriangleAlert aria-hidden="true" />
            {deleteBusy ? 'Deleting project…' : 'Delete this project'}
          </button>
        </div>
        {deleteError && <p className="platform-form-error" role="alert">{deleteError}</p>}
      </section>
    )}
  </div>;
}

function NoProject() {
  const context = useOutletContext<PlatformOutletContext>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (context.loading) return <div className="route-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading workspace…</div>;
  if (!context.organization) return <div className="platform-page"><Empty title="No organization yet" detail="Create an organization from the activity page first." /></div>;
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const slug = String(form.get('slug'));
      await platformApi.createProject(context.organization!.slug, {
        name: String(form.get('name')), slug,
        description: String(form.get('description') || ''), visibility: 'private',
      });
      await context.reload();
      navigate(`/app/${context.organization!.slug}/${slug}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Project creation failed.'); }
  };
  return <div className="platform-page"><PageHeading eyebrow={context.organization.name} title="Create a first project" detail="Projects isolate cases, studies, artifacts and permissions." action={<Link className="platform-primary-action" to={`/app/${context.organization.slug}/settings`}><Users aria-hidden="true" />Organization settings</Link>} />
    <form className="standalone-form" onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label>{error && <p role="alert">{error}</p>}<button>Create private project</button></form>
  </div>;
}

export function CasesPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [cases, setCases] = useState<BindingCase[]>([]);
  const [revisions, setRevisions] = useState<Record<string, CaseRevision[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [inspectCase, setInspectCase] = useState<BindingCase | null>(null);
  const [inspectRevision, setInspectRevision] = useState<{ caseItem: BindingCase; revision: CaseRevision } | null>(null);

  const load = useCallback(
    () => {
      if (!organization || !project) return Promise.resolve();
      return platformApi.cases(organization.slug, project.slug)
        .then(async (next) => [next, Object.fromEntries(await Promise.all(next.map(async (item) => [
          item.id,
          await platformApi.revisions(organization.slug, project.slug, item.slug),
        ])))] as const)
        .then(([next, nextRevisions]) => { setCases(next); setRevisions(nextRevisions); });
    },
    [organization, project],
  );
  useEffect(() => { void load(); }, [load]);
  if (!organization || !project) return <NoProject />;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(null);
    try { await platformApi.createCase(organization.slug, project.slug, { name: String(form.get('name')), slug: String(form.get('slug')), description: String(form.get('description') || '') }); event.currentTarget.reset(); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Case creation failed.'); }
  };

  const createRevision = async (event: FormEvent<HTMLFormElement>, item: BindingCase) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    try {
      const document = JSON.parse(String(form.get('document'))) as Record<string, unknown>;
      const sourceSnapshot = String(form.get('source_snapshot_id') || '').trim();
      await platformApi.createRevision(
        organization.slug,
        project.slug,
        item.slug,
        document,
        sourceSnapshot || null,
      );
      event.currentTarget.reset();
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Revision creation failed.'); }
  };

  return (
    <div className="platform-page">
      <PageHeading eyebrow="Project resources" title="Binding cases" detail="A case is the durable identity; each edit creates an immutable revision pinned to its source snapshot." />
      {error && <p className="platform-form-error" role="alert">{error}</p>}
      <div className="case-grid">
        {cases.map((item) => (
          <article key={item.id}>
            <header>
              <span>{item.slug}</span>
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setInspectCase(item)}
                  className="hash-badge"
                  style={{ cursor: 'pointer', padding: '3px 7px' }}
                  title="Inspect & Edit Case"
                >
                  <Eye size={12} /> Inspect
                </button>
                <LockKeyhole aria-label="Immutable revisions" />
              </div>
            </header>
            <h2>
              <Link to={`/app/${organization.slug}/${project.slug}/cases/${item.slug}`} style={{ color: 'inherit', textDecoration: 'none' }} title="Open dedicated case detail page">
                {item.name}
              </Link>
            </h2>
            <p>{item.description || 'No description yet.'}</p>
            <div className="case-revisions">
              <strong><History aria-hidden="true" /> {revisions[item.id]?.length ?? 0} revisions</strong>
              {revisions[item.id]?.slice(0, 3).map((revision) => (
                <div key={revision.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '2px' }}>
                  <button
                    type="button"
                    onClick={() => setInspectRevision({ caseItem: item, revision })}
                    className="hash-badge"
                    style={{ cursor: 'pointer' }}
                    title="Inspect revision JSON document"
                  >
                    r{revision.revision} · {revision.digest.slice(0, 16)}…
                  </button>
                  {revision.source_snapshot_id && (
                    <Link
                      to={`/app/${organization.slug}/${project.slug}/snapshots/${revision.source_snapshot_id}`}
                      className="hash-badge"
                      style={{ color: '#f59e0b', textDecoration: 'none', padding: '2px 6px', fontSize: '0.72rem' }}
                      title="Inspect decompressed snapshot .bim.zip & IR"
                    >
                      <Archive size={11} /> Snapshot
                    </Link>
                  )}
                </div>
              ))}
              <details>
                <summary>Attach JSON revision</summary>
                <form onSubmit={(event) => void createRevision(event, item)}>
                  <label>Case document<textarea name="document" required rows={6} spellCheck={false} placeholder={'{\n  "apiVersion": "bim/v1",\n  "kind": "Instance",\n  "metadata": { "name": "example" },\n  "spec": { "profile": "qos-binding/v1", "resources": {} }\n}'} /></label>
                  <label>Executable snapshot UUID <small>optional</small><input name="source_snapshot_id" type="text" inputMode="text" pattern="[0-9a-fA-F-]{36}" placeholder="Created by the workbench before solving" /></label>
                  <button>Create immutable revision</button>
                </form>
              </details>
            </div>
            <footer>
              <small>{new Date(item.created_at).toLocaleDateString()}</small>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <Link to={`/app/${organization.slug}/${project.slug}/cases/${item.slug}`}>Case view <ArrowRight aria-hidden="true" /></Link>
                <Link to={`/app/${organization.slug}/${project.slug}/workbench`}>Workbench <ArrowRight aria-hidden="true" /></Link>
              </div>
            </footer>
          </article>
        ))}
      </div>
      {!cases.length && <Empty title="No cases yet" detail="Create a durable identity, then attach BIM snapshots as immutable revisions." />}
      <details className="inline-create-panel"><summary><Plus aria-hidden="true" /> New binding case</summary><form onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label>{error && <p role="alert">{error}</p>}<button>Create case</button></form></details>

      {/* Slide-over Drawer for Case */}
      {inspectCase && (
        <EntityDrawer
          isOpen={Boolean(inspectCase)}
          onClose={() => setInspectCase(null)}
          title={inspectCase.name}
          subtitle={`Case Slug: ${inspectCase.slug}`}
          badge={{ label: `${revisions[inspectCase.id]?.length ?? 0} REVISIONS`, variant: 'default' }}
          fullPageUrl={`/app/${organization.slug}/${project.slug}/cases/${inspectCase.slug}`}
          metadata={[
            { label: 'Slug', value: inspectCase.slug },
            { label: 'Name', value: inspectCase.name },
            { label: 'Created At', value: new Date(inspectCase.created_at).toLocaleString() },
            { label: 'Description', value: inspectCase.description || 'None' },
            { label: 'Total Revisions', value: String(revisions[inspectCase.id]?.length ?? 0) },
          ]}
          editable={{
            fields: [
              { key: 'name', label: 'Case Name', initialValue: inspectCase.name },
              { key: 'description', label: 'Description', type: 'textarea', initialValue: inspectCase.description || '' },
            ],
            onSave: async (vals) => {
              await platformApi.updateCase(organization.slug, project.slug, inspectCase.slug, {
                name: vals.name,
                description: vals.description,
              });
              await load();
            },
          }}
          deletable={{
            confirmMessage: `Permanently delete case "${inspectCase.name}" and all its revisions?`,
            onDelete: async () => {
              await platformApi.deleteCase(organization.slug, project.slug, inspectCase.slug);
              await load();
            },
          }}
        />
      )}

      {/* Slide-over Drawer for Case Revision */}
      {inspectRevision && (
        <EntityDrawer
          isOpen={Boolean(inspectRevision)}
          onClose={() => setInspectRevision(null)}
          title={`${inspectRevision.caseItem.name} · Revision r${inspectRevision.revision.revision}`}
          subtitle={`Digest: ${inspectRevision.revision.digest}`}
          badge={{ label: `REVISION r${inspectRevision.revision.revision}`, variant: 'default' }}
          metadata={[
            { label: 'Case', value: inspectRevision.caseItem.name },
            { label: 'Revision Number', value: `r${inspectRevision.revision.revision}` },
            { label: 'Digest', value: inspectRevision.revision.digest },
            { label: 'Created At', value: new Date(inspectRevision.revision.created_at).toLocaleString() },
            {
              label: 'Source Snapshot',
              value: inspectRevision.revision.source_snapshot_id ? (
                <Link
                  to={`/app/${organization.slug}/${project.slug}/snapshots/${inspectRevision.revision.source_snapshot_id}`}
                  className="hash-badge"
                  style={{ color: '#f59e0b', textDecoration: 'none' }}
                >
                  <Archive size={12} /> Inspect Snapshot
                </Link>
              ) : 'None attached',
            },
          ]}
          jsonDocument={inspectRevision.revision.document}
          fullPageUrl={inspectRevision.revision.source_snapshot_id ? `/app/${organization.slug}/${project.slug}/snapshots/${inspectRevision.revision.source_snapshot_id}` : undefined}
        />
      )}
    </div>
  );
}

export function ResourcesPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [resources, setResources] = useState<ProjectResource[]>([]);
  const [revisions, setRevisions] = useState<Record<string, ProjectResourceRevision[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [inspectResource, setInspectResource] = useState<ProjectResource | null>(null);
  const [inspectResRevision, setInspectResRevision] = useState<{ res: ProjectResource; revision: ProjectResourceRevision } | null>(null);

  const load = useCallback(async () => {
    if (!organization || !project) return;
    try {
      const next = await platformApi.resources(organization.slug, project.slug);
      setResources(next);
      setRevisions(Object.fromEntries(await Promise.all(next.map(async (item) => [
        item.id,
        await platformApi.resourceRevisions(organization.slug, project.slug, item.slug),
      ]))));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Resources could not be loaded.');
    }
  }, [organization, project]);
  useEffect(() => {
    if (!organization || !project) return;
    let active = true;
    void platformApi.resources(organization.slug, project.slug)
      .then(async (next) => {
        const nextRevisions = Object.fromEntries(await Promise.all(next.map(async (item) => [
          item.id,
          await platformApi.resourceRevisions(organization.slug, project.slug, item.slug),
        ])));
        if (active) {
          setResources(next);
          setRevisions(nextRevisions);
        }
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Resources could not be loaded.');
      });
    return () => { active = false; };
  }, [organization, project]);
  if (!organization || !project) return <NoProject />;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(null);
    try {
      await platformApi.createResource(organization.slug, project.slug, {
        name: String(form.get('name')),
        slug: String(form.get('slug')),
        description: String(form.get('description') || ''),
        kind: String(form.get('kind') || 'bim-resource'),
      });
      event.currentTarget.reset(); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Resource creation failed.'); }
  };
  const addRevision = async (event: FormEvent<HTMLFormElement>, resource: ProjectResource) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(null);
    try {
      const document = JSON.parse(String(form.get('document'))) as Record<string, unknown>;
      await platformApi.createResourceRevision(organization.slug, project.slug, resource.slug, document);
      event.currentTarget.reset(); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Resource revision failed.'); }
  };

  return (
    <div className="platform-page resources-page">
      <PageHeading eyebrow="Reusable project material" title="Resources" detail="Catalogues, datasets, constraints and other supporting documents keep their own immutable, digest-addressed revision history." />
      {error && <p className="platform-form-error" role="alert">{error}</p>}
      <div className="case-grid">
        {resources.map((resource) => (
          <article key={resource.id}>
            <header>
              <span>{resource.kind}</span>
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => setInspectResource(resource)}
                  className="hash-badge"
                  style={{ cursor: 'pointer', padding: '3px 7px' }}
                  title="Inspect & Edit Resource"
                >
                  <Eye size={12} /> Inspect
                </button>
                <Database aria-label="Versioned resource" />
              </div>
            </header>
            <h2>{resource.name}</h2>
            <p>{resource.description || resource.slug}</p>
            <div className="case-revisions">
              <strong><History aria-hidden="true" /> {revisions[resource.id]?.length ?? 0} revisions</strong>
              {revisions[resource.id]?.slice(-3).reverse().map((revision) => (
                <div key={revision.id} style={{ marginTop: '2px' }}>
                  <button
                    type="button"
                    onClick={() => setInspectResRevision({ res: resource, revision })}
                    className="hash-badge"
                    style={{ cursor: 'pointer' }}
                    title="Inspect revision JSON document"
                  >
                    r{revision.revision} · {revision.digest.slice(0, 16)}…
                  </button>
                </div>
              ))}
              <details>
                <summary>Attach JSON revision</summary>
                <form onSubmit={(event) => void addRevision(event, resource)}>
                  <label>Resource document<textarea name="document" required rows={7} spellCheck={false} placeholder={'{\n  "apiVersion": "openbinding.dev/qos-binding/v1",\n  "kind": "CandidateCatalog",\n  "spec": {}\n}'} /></label>
                  <button>Create immutable revision</button>
                </form>
              </details>
            </div>
            <footer>
              <small>{resource.slug}</small>
              <LockKeyhole aria-label="Immutable by digest" />
            </footer>
          </article>
        ))}
      </div>
      {!resources.length && <Empty title="No project resources" detail="Create a named resource, then attach checksum-verified revisions for collections and reproducible packages." />}
      <details className="inline-create-panel"><summary><Plus aria-hidden="true" /> New project resource</summary><form onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Kind<input name="kind" defaultValue="bim-resource" required /></label><label>Description<textarea name="description" rows={3} /></label><button>Create resource</button></form></details>

      {/* Slide-over Drawer for Resource */}
      {inspectResource && (
        <EntityDrawer
          isOpen={Boolean(inspectResource)}
          onClose={() => setInspectResource(null)}
          title={inspectResource.name}
          subtitle={`Resource Slug: ${inspectResource.slug}`}
          badge={{ label: inspectResource.kind.toUpperCase(), variant: 'default' }}
          metadata={[
            { label: 'Slug', value: inspectResource.slug },
            { label: 'Kind', value: inspectResource.kind },
            { label: 'Name', value: inspectResource.name },
            { label: 'Created At', value: new Date(inspectResource.created_at).toLocaleString() },
            { label: 'Description', value: inspectResource.description || 'None' },
            { label: 'Total Revisions', value: String(revisions[inspectResource.id]?.length ?? 0) },
          ]}
          editable={{
            fields: [
              { key: 'name', label: 'Resource Name', initialValue: inspectResource.name },
              { key: 'kind', label: 'Kind', initialValue: inspectResource.kind },
              { key: 'description', label: 'Description', type: 'textarea', initialValue: inspectResource.description || '' },
            ],
            onSave: async (vals) => {
              await platformApi.updateResource(organization.slug, project.slug, inspectResource.slug, {
                name: vals.name,
                kind: vals.kind,
                description: vals.description,
              });
              await load();
            },
          }}
          deletable={{
            confirmMessage: `Permanently delete resource "${inspectResource.name}" and all its revisions?`,
            onDelete: async () => {
              await platformApi.deleteResource(organization.slug, project.slug, inspectResource.slug);
              await load();
            },
          }}
        />
      )}

      {/* Slide-over Drawer for Resource Revision */}
      {inspectResRevision && (
        <EntityDrawer
          isOpen={Boolean(inspectResRevision)}
          onClose={() => setInspectResRevision(null)}
          title={`${inspectResRevision.res.name} · Revision r${inspectResRevision.revision.revision}`}
          subtitle={`Digest: ${inspectResRevision.revision.digest}`}
          badge={{ label: `REVISION r${inspectResRevision.revision.revision}`, variant: 'default' }}
          metadata={[
            { label: 'Resource', value: inspectResRevision.res.name },
            { label: 'Revision Number', value: `r${inspectResRevision.revision.revision}` },
            { label: 'Digest', value: inspectResRevision.revision.digest },
            { label: 'Created At', value: new Date(inspectResRevision.revision.created_at).toLocaleString() },
          ]}
          jsonDocument={inspectResRevision.revision.document}
        />
      )}
    </div>
  );
}

export function CollectionsPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [revisions, setRevisions] = useState<Record<string, CollectionRevision[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [inspectCollection, setInspectCollection] = useState<Collection | null>(null);
  const [inspectColRevision, setInspectColRevision] = useState<{ col: Collection; revision: CollectionRevision } | null>(null);

  const load = useCallback(async () => {
    if (!organization || !project) return;
    const next = await platformApi.collections(organization.slug, project.slug);
    setCollections(next);
    setRevisions(Object.fromEntries(await Promise.all(next.map(async (item) => [item.id, await platformApi.collectionRevisions(organization.slug, project.slug, item.slug)]))));
  }, [organization, project]);
  useEffect(() => { void load(); }, [load]);
  if (!organization || !project) return <NoProject />;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(null);
    try { await platformApi.createCollection(organization.slug, project.slug, { name: String(form.get('name')), slug: String(form.get('slug')), description: String(form.get('description') || '') }); event.currentTarget.reset(); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Collection creation failed.'); }
  };
  const addRevision = async (event: FormEvent<HTMLFormElement>, collection: Collection) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(null);
    try {
      const items = JSON.parse(String(form.get('items'))) as CollectionItem[];
      if (!Array.isArray(items)) throw new Error('Collection items must be a JSON array.');
      await platformApi.createCollectionRevision(organization.slug, project.slug, collection.slug, items);
      event.currentTarget.reset(); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Collection revision failed.'); }
  };

  return (
    <div className="platform-page collections-page">
      <PageHeading eyebrow="Curated evidence" title="Collections" detail="A collection is an ordered, versioned set of immutable case, resource, result or report references. It never executes work; a study may pin one of its revisions as input." />
      {error && <p className="platform-form-error" role="alert">{error}</p>}
      <div className="collection-grid">
        {collections.map((collection) => {
          const latest = revisions[collection.id]?.[0];
          return (
            <article key={collection.id}>
              <header>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Library aria-hidden="true" />
                  <span>{collection.slug}</span>
                </div>
                <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => setInspectCollection(collection)}
                    className="hash-badge"
                    style={{ cursor: 'pointer', padding: '3px 7px' }}
                    title="Inspect & Edit Collection"
                  >
                    <Eye size={12} /> Inspect
                  </button>
                  <Link
                    to={`/app/${organization.slug}/${project.slug}/collections/${collection.slug}`}
                    className="hash-badge"
                    style={{ textDecoration: 'none', padding: '3px 7px' }}
                    title="Open full page view"
                  >
                    <ExternalLink size={12} /> Full view
                  </Link>
                  <small>{revisions[collection.id]?.length ?? 0} revisions</small>
                </div>
              </header>
              <h2>{collection.name}</h2>
              <p>{collection.description || 'No description yet.'}</p>
              {latest ? (
                <div
                  className="collection-latest"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setInspectColRevision({ col: collection, revision: latest })}
                  title="Click to inspect immutable collection revision"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                    <span>Latest revision</span>
                    <span className="hash-badge" style={{ fontSize: '0.72rem', padding: '1px 5px' }}>
                      <Eye size={10} /> Inspect r{latest.revision}
                    </span>
                  </div>
                  <strong>r{latest.revision} · {latest.items.length} references</strong>
                  <code>{latest.digest}</code>
                </div>
              ) : (
                <div className="collection-latest is-empty">No curated revision yet.</div>
              )}
              <details>
                <summary><Plus aria-hidden="true" /> New immutable revision</summary>
                <form onSubmit={(event) => void addRevision(event, collection)}>
                  <label>Ordered reference array<textarea name="items" required rows={8} spellCheck={false} placeholder={'[\n  {\n    "target_kind": "case",\n    "target_digest": "sha256-…",\n    "target_ref": { "case": "checkout", "revision": 3 }\n  }\n]'} /></label>
                  <button>Create revision</button>
                </form>
              </details>
            </article>
          );
        })}
      </div>
      {!collections.length && <Empty title="No collections yet" detail="Create one when you need a stable, curated corpus across cases, resources or published results." />}
      <details className="inline-create-panel"><summary><Plus aria-hidden="true" /> New collection</summary><form onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label><button>Create collection</button></form></details>

      {/* Slide-over Drawer for Collection */}
      {inspectCollection && (
        <EntityDrawer
          isOpen={Boolean(inspectCollection)}
          onClose={() => setInspectCollection(null)}
          title={inspectCollection.name}
          subtitle={`Collection Slug: ${inspectCollection.slug}`}
          badge={{ label: `${revisions[inspectCollection.id]?.length ?? 0} REVISIONS`, variant: 'default' }}
          fullPageUrl={`/app/${organization.slug}/${project.slug}/collections/${inspectCollection.slug}`}
          metadata={[
            { label: 'Slug', value: inspectCollection.slug },
            { label: 'Name', value: inspectCollection.name },
            { label: 'Created At', value: new Date(inspectCollection.created_at).toLocaleString() },
            { label: 'Description', value: inspectCollection.description || 'None' },
            { label: 'Total Revisions', value: String(revisions[inspectCollection.id]?.length ?? 0) },
          ]}
          editable={{
            fields: [
              { key: 'name', label: 'Collection Name', initialValue: inspectCollection.name },
              { key: 'description', label: 'Description', type: 'textarea', initialValue: inspectCollection.description || '' },
            ],
            onSave: async (vals) => {
              await platformApi.updateCollection(organization.slug, project.slug, inspectCollection.slug, {
                name: vals.name,
                description: vals.description,
              });
              await load();
            },
          }}
          deletable={{
            confirmMessage: `Permanently delete collection "${inspectCollection.name}" and all its revisions?`,
            onDelete: async () => {
              await platformApi.deleteCollection(organization.slug, project.slug, inspectCollection.slug);
              await load();
            },
          }}
          jsonDocument={revisions[inspectCollection.id]?.[0] ? (revisions[inspectCollection.id][0] as unknown as Record<string, unknown>) : null}
        />
      )}

      {/* Slide-over Drawer for Collection Revision */}
      {inspectColRevision && (
        <EntityDrawer
          isOpen={Boolean(inspectColRevision)}
          onClose={() => setInspectColRevision(null)}
          title={`${inspectColRevision.col.name} · Revision r${inspectColRevision.revision.revision}`}
          subtitle={`Digest: ${inspectColRevision.revision.digest}`}
          badge={{ label: `REVISION r${inspectColRevision.revision.revision}`, variant: 'default' }}
          metadata={[
            { label: 'Collection', value: inspectColRevision.col.name },
            { label: 'Collection Slug', value: inspectColRevision.col.slug },
            { label: 'Revision Number', value: `r${inspectColRevision.revision.revision}` },
            { label: 'Total References', value: String(inspectColRevision.revision.items.length) },
            { label: 'Digest', value: <code className="hash-badge" title={inspectColRevision.revision.digest}>{inspectColRevision.revision.digest}</code> },
            { label: 'Created At', value: new Date(inspectColRevision.revision.created_at).toLocaleString() },
          ]}
          jsonDocument={{
            collection: inspectColRevision.col.slug,
            revision: inspectColRevision.revision.revision,
            digest: inspectColRevision.revision.digest,
            items: inspectColRevision.revision.items,
          }}
        />
      )}
    </div>
  );
}

export function StudiesPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [studies, setStudies] = useState<Study[]>([]);
  const [runs, setRuns] = useState<Record<string, StudyRun[]>>({});
  const [runCells, setRunCells] = useState<Record<string, StudyCell[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [cases, setCases] = useState<BindingCase[]>([]);
  const [caseRevisions, setCaseRevisions] = useState<Record<string, CaseRevision[]>>({});
  const [engines, setEngines] = useState<EngineCatalogEntry[]>([]);
  const [selectedRevisions, setSelectedRevisions] = useState<string[]>([]);
  const [selectedEngines, setSelectedEngines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inspectStudy, setInspectStudy] = useState<Study | null>(null);

  const load = useCallback(async () => {
    if (!organization || !project) return;
    const [next, nextCases, nextEngines] = await Promise.all([
      platformApi.studies(organization.slug, project.slug),
      platformApi.cases(organization.slug, project.slug),
      apiClient.getEngines(),
    ]);
    setStudies(next); setCases(nextCases); setEngines(nextEngines);
    setCaseRevisions(Object.fromEntries(await Promise.all(nextCases.map(async (item) => [item.id, await platformApi.revisions(organization.slug, project.slug, item.slug)]))));
    const nextRuns = Object.fromEntries(await Promise.all(next.map(async (study) => [study.id, await platformApi.studyRuns(organization.slug, project.slug, study.slug)])));
    setRuns(nextRuns);
    setRunCells(Object.fromEntries(await Promise.all(next.flatMap((study) => {
      const latest = nextRuns[study.id]?.[0];
      return latest ? [[latest.id, platformApi.studyCells(organization.slug, project.slug, study.slug, latest.id)]] : [];
    }).map(async ([runId, request]) => [runId, await request]))));
  }, [organization, project]);
  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Studies could not be loaded.')); }, [load]);
  if (!organization || !project) return <NoProject />;
  const execute = async (study: Study) => {
    setRunning(study.id); setError(null);
    try { await platformApi.runStudy(organization.slug, project.slug, study.slug); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Study dispatch failed.'); }
    finally { setRunning(null); }
  };
  const cancel = async (study: Study, run: StudyRun) => {
    setRunning(`cancel:${run.id}`); setError(null);
    try { await platformApi.cancelStudyRun(organization.slug, project.slug, study.slug, run.id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Study cancellation failed.'); }
    finally { setRunning(null); }
  };
  const retry = async (study: Study, run: StudyRun, cell: StudyCell) => {
    setRunning(`retry:${cell.id}`); setError(null);
    try { await platformApi.retryStudyCell(organization.slug, project.slug, study.slug, run.id, cell.id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Cell retry failed.'); }
    finally { setRunning(null); }
  };
  const engineChoices = engines.flatMap((engine) => engine.modes.map((mode) => ({ engine, mode, key: `${bimResourceKey(engine.ref)}#${mode.id}` })));
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null);
    const form = new FormData(event.currentTarget);
    try {
      if (!selectedRevisions.length) throw new Error('Choose at least one executable case revision.');
      if (!selectedEngines.length) throw new Error('Choose at least one exact Engine mode.');
      const parameterSets = JSON.parse(String(form.get('parameters') || '[{}]')) as Array<Record<string, unknown>>;
      if (!Array.isArray(parameterSets) || !parameterSets.length) throw new Error('Parameter sets must be a non-empty JSON array.');
      const seeds = String(form.get('seeds') || '0').split(',').map((seed) => Number(seed.trim()));
      if (!seeds.length || seeds.some((seed) => !Number.isSafeInteger(seed))) throw new Error('Seeds must be comma-separated integers.');
      await platformApi.createStudy(organization.slug, project.slug, {
        slug: String(form.get('slug')), name: String(form.get('name')),
        description: String(form.get('description') || ''),
        definition: {
          case_revision_ids: selectedRevisions,
          engines: engineChoices.filter((choice) => selectedEngines.includes(choice.key)).map(({ engine, mode }) => ({ ...engine.ref, mode: mode.id })),
          parameter_sets: parameterSets,
          seeds,
        },
      });
      event.currentTarget.reset(); setSelectedRevisions([]); setSelectedEngines([]); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Study creation failed.'); }
  };
  return (
    <div className="platform-page">
      <PageHeading eyebrow="Reproducible experiments" title="Comparative studies" detail="Each run freezes the Cartesian matrix of case revisions, engine revisions, parameter sets and seeds before dispatch." />
      {error && <p className="platform-form-error" role="alert">{error}</p>}
      <div className="study-list">
        {studies.map((study) => {
          const latest = runs[study.id]?.[0]; const cells = study.definition.case_revision_ids.length * study.definition.engines.length * study.definition.parameter_sets.length * study.definition.seeds.length;
          const retryable = latest ? (runCells[latest.id] ?? []).filter((cell) => cell.state === 'failed' || cell.state === 'cancelled') : [];
          return (
            <article key={study.id}>
              <div className="study-index">
                <FlaskConical aria-hidden="true" />
                <span>{cells}<small>cells</small></span>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span className="status-chip">{study.state}</span>
                  <button
                    type="button"
                    onClick={() => setInspectStudy(study)}
                    className="hash-badge"
                    style={{ cursor: 'pointer', padding: '2px 6px' }}
                    title="Inspect & Edit Study"
                  >
                    <Eye size={12} /> Inspect
                  </button>
                </div>
                <h2>{study.name}</h2>
                <p>{study.description || 'Exact comparative matrix.'}</p>
                <div className="study-formula">
                  <code>{study.definition.case_revision_ids.length} cases</code>
                  <b>×</b>
                  <code>{study.definition.engines.length} engines</code>
                  <b>×</b>
                  <code>{study.definition.parameter_sets.length} parameters</code>
                  <b>×</b>
                  <code>{study.definition.seeds.length} seeds</code>
                </div>
                {latest && retryable.length > 0 && (
                  <details className="study-retries">
                    <summary>{retryable.length} retryable cell{retryable.length === 1 ? '' : 's'}</summary>
                    <div>
                      {retryable.map((cell) => (
                        <button key={cell.id} type="button" disabled={running !== null} onClick={() => void retry(study, latest, cell)}>
                          <RefreshCw aria-hidden="true" /> Cell {cell.ordinal + 1} · {running === `retry:${cell.id}` ? 'retrying…' : cell.state}
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
              <aside>
                {latest ? (
                  <>
                    <small>Latest run #{latest.run_number}</small>
                    <strong className={`run-state is-${latest.state}`}>{latest.state}</strong>
                    <Link to={`/app/${organization.slug}/${project.slug}/analytics`}>
                      Inspect analysis <ArrowRight aria-hidden="true" />
                    </Link>
                    {(latest.state === 'queued' || latest.state === 'running') && (
                      <button className="study-cancel" type="button" onClick={() => void cancel(study, latest)} disabled={running !== null}>
                        <CircleStop aria-hidden="true" />{running === `cancel:${latest.id}` ? 'Cancelling…' : 'Cancel run'}
                      </button>
                    )}
                  </>
                ) : (
                  <small>Never run</small>
                )}
                <button type="button" onClick={() => void execute(study)} disabled={running !== null}>
                  <RefreshCw aria-hidden="true" />{running === study.id ? 'Dispatching…' : 'Run matrix'}
                </button>
              </aside>
            </article>
          );
        })}
      </div>
      {!studies.length && <Empty title="No study definitions" detail="Create a study from a case after choosing exact compatible engine revisions and seeds." action={<Link to={`/app/${organization.slug}/${project.slug}/cases`}>Choose a case</Link>} />}
      <details className="study-builder"><summary><Plus aria-hidden="true" /> Define comparative study</summary><form onSubmit={create}><div className="study-builder-fields"><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label></div><div className="study-builder-matrix"><fieldset><legend>Executable case revisions</legend>{cases.map((item) => { const revision = caseRevisions[item.id]?.find((candidate) => candidate.source_snapshot_id); return <label key={item.id} className={!revision ? 'is-disabled' : undefined}><input type="checkbox" disabled={!revision} checked={Boolean(revision && selectedRevisions.includes(revision.id))} onChange={() => revision && setSelectedRevisions((current) => current.includes(revision.id) ? current.filter((id) => id !== revision.id) : [...current, revision.id])} /><span><strong>{item.name}</strong><small>{revision ? `r${revision.revision} · ${revision.digest.slice(0, 15)}…` : 'Attach a revision backed by a BIM snapshot first'}</small></span></label>; })}{!cases.length && <p>No binding cases yet.</p>}</fieldset><fieldset><legend>Exact Engine modes</legend>{engineChoices.map(({ engine, mode, key }) => <label key={key}><input type="checkbox" checked={selectedEngines.includes(key)} onChange={() => setSelectedEngines((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} /><span><strong>{engine.namespace}/{engine.name}</strong><small>{engine.version} · {mode.id} · {engine.digest.slice(0, 12)}…</small></span></label>)}{!engineChoices.length && <p>No compatible engines visible.</p>}</fieldset></div><div className="study-builder-options"><label>Parameter sets (JSON array)<textarea name="parameters" rows={5} defaultValue="[{}]" spellCheck={false} /></label><label>Seeds<input name="seeds" defaultValue="0" placeholder="0, 1, 2" /></label><output>{selectedRevisions.length || 0} × {selectedEngines.length || 0} × parameters × seeds</output><button>Create immutable definition</button></div></form></details>

      {/* Slide-over Drawer for Study */}
      {inspectStudy && (
        <EntityDrawer
          isOpen={Boolean(inspectStudy)}
          onClose={() => setInspectStudy(null)}
          title={inspectStudy.name}
          subtitle={`Study Slug: ${inspectStudy.slug} · State: ${inspectStudy.state}`}
          badge={{ label: inspectStudy.state.toUpperCase(), variant: 'default' }}
          metadata={[
            { label: 'Slug', value: inspectStudy.slug },
            { label: 'Name', value: inspectStudy.name },
            { label: 'State', value: inspectStudy.state },
            { label: 'Created At', value: new Date(inspectStudy.created_at).toLocaleString() },
            { label: 'Description', value: inspectStudy.description || 'None' },
            { label: 'Cases in Matrix', value: String(inspectStudy.definition.case_revision_ids.length) },
            { label: 'Engines', value: inspectStudy.definition.engines.map((e) => `${e.namespace}/${e.name}`).join(', ') },
            { label: 'Seeds', value: inspectStudy.definition.seeds.join(', ') },
          ]}
          editable={{
            fields: [
              { key: 'name', label: 'Study Name', initialValue: inspectStudy.name },
              { key: 'description', label: 'Description', type: 'textarea', initialValue: inspectStudy.description || '' },
            ],
            onSave: async (vals) => {
              await platformApi.updateStudy(organization.slug, project.slug, inspectStudy.slug, {
                name: vals.name,
                description: vals.description,
              });
              await load();
            },
          }}
          deletable={{
            confirmMessage: `Permanently delete comparative study "${inspectStudy.name}" and all associated runs/cells?`,
            onDelete: async () => {
              await platformApi.deleteStudy(organization.slug, project.slug, inspectStudy.slug);
              await load();
            },
          }}
          jsonDocument={inspectStudy.definition as unknown as Record<string, unknown>}
        />
      )}
    </div>
  );
}

export function AnalyticsPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [studies, setStudies] = useState<Study[]>([]);
  const [selection, setSelection] = useState<{ study: Study; run: StudyRun } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [cells, setCells] = useState<StudyCell[]>([]);
  const [inspectCell, setInspectCell] = useState<StudyCell | null>(null);
  useEffect(() => {
    if (!organization || !project) return;
    void platformApi.studies(organization.slug, project.slug).then(async (next) => {
      setStudies(next);
      for (const study of next) {
        const runs = await platformApi.studyRuns(organization.slug, project.slug, study.slug);
        if (runs[0]) { setSelection({ study, run: runs[0] }); return; }
      }
    });
  }, [organization, project]);
  useEffect(() => {
    if (!organization || !project || !selection) return;
    void Promise.all([
      platformApi.analytics(organization.slug, project.slug, selection.study.slug, selection.run.id),
      platformApi.studyCells(organization.slug, project.slug, selection.study.slug, selection.run.id),
    ]).then(([nextAnalytics, nextCells]) => { setAnalytics(nextAnalytics); setCells(nextCells); });
  }, [organization, project, selection]);
  const objectiveKeys = useMemo(() => Object.keys(analytics?.pareto[0] ?? {}), [analytics]);
  const scatter = (analytics?.pareto ?? []).map((point) => ({ x: point[objectiveKeys[0]], y: point[objectiveKeys[1] ?? objectiveKeys[0]] }));
  if (!organization || !project) return <NoProject />;
  return <div className="platform-page analysis-page"><PageHeading eyebrow="Evidence, not decoration" title="Binding analysis" detail="Inspect feasibility, objective trade-offs, timing and stability while retaining the cell fingerprints behind every point." action={studies.length > 1 ? <select aria-label="Study run" value={selection?.study.id ?? ''} onChange={(event) => { const study = studies.find((item) => item.id === event.target.value); if (study) void platformApi.studyRuns(organization.slug, project.slug, study.slug).then((runs) => runs[0] && setSelection({ study, run: runs[0] })); }}>{studies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : undefined} />
    {!analytics ? <Empty title="No completed study to analyze" detail="Run a comparative study; this surface will derive its charts from the persisted cell metrics." /> : <>
      <div className="analysis-kpis">
        <article><CheckCircle2 /><small>Feasible</small><strong>{analytics.feasible}</strong><span>of {analytics.cells} cells</span></article>
        <article><TriangleAlert /><small>Failed</small><strong>{analytics.failed}</strong><span>retryable cells</span></article>
        <article><Clock3 /><small>Median runtime</small><strong>{analytics.runtimes_s.length ? `${analytics.runtimes_s[Math.floor(analytics.runtimes_s.length / 2)].toFixed(2)}s` : '—'}</strong><span>end-to-end</span></article>
        <article><Sparkles /><small>Pareto front</small><strong>{analytics.pareto.length}</strong><span>nondominated points</span></article>
        {analytics.binding_space && (
          <article>
            <Layers3 />
            <small>Binding space</small>
            <strong>{parseBindingSpace(analytics.binding_space.cardinality).formatted}</strong>
            <span>10{toSuperscript(Math.round(analytics.binding_space.log10))} combinations ({analytics.binding_space.tasks} tasks)</span>
          </article>
        )}
      </div>
      <div className="analysis-grid">
        {analytics.binding_space && (
          <article className="analysis-panel binding-space-panel">
            <header>
              <div>
                <span>Combinatorial Complexity</span>
                <h2>Instance search space</h2>
              </div>
              <small>
                {analytics.binding_space.case_name ? `${analytics.binding_space.case_name} · rev ${analytics.binding_space.revision}` : 'Analyzed instance'}
              </small>
            </header>
            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <BindingSpaceBadge
                cardinality={analytics.binding_space.cardinality}
                breakdown={analytics.binding_space.breakdown}
                variant="card"
              />
              {analytics.binding_space.cases && analytics.binding_space.cases.length > 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Cases complexity breakdown
                  </span>
                  {analytics.binding_space.cases.map((c) => (
                    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.85rem', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                      <div>
                        <strong>{c.name}</strong>
                        <small style={{ display: 'block', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>rev {c.revision} · {c.tasks} tasks</small>
                      </div>
                      <BindingSpaceBadge cardinality={c.cardinality} breakdown={c.breakdown} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        )}
        <article className="analysis-panel pareto-panel"><header><div><span>Pareto explorer</span><h2>{objectiveKeys.length > 1 ? `${objectiveKeys[0]} × ${objectiveKeys[1]}` : 'Objective frontier'}</h2></div><small>minimize · exact cell results</small></header><div className="chart-frame">{scatter.length ? <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 20, right: 25, bottom: 25, left: 10 }}><CartesianGrid stroke="var(--color-border)" strokeDasharray="2 5"/><XAxis type="number" dataKey="x" name={objectiveKeys[0]} stroke="var(--color-text-tertiary)"/><YAxis type="number" dataKey="y" name={objectiveKeys[1]} stroke="var(--color-text-tertiary)"/><Tooltip cursor={{ strokeDasharray: '3 3' }}/><Scatter data={scatter} fill="var(--color-accent)" /></ScatterChart></ResponsiveContainer> : <Empty title="No objective points" detail="Completed feasible solutions with numeric objectives appear here." />}</div></article>
        <article className="analysis-panel"><header><div><span>Runtime distribution</span><h2>Cost of evidence</h2></div></header><div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><BarChart data={analytics.runtimes_s.map((value, index) => ({ cell: index + 1, seconds: value }))}><CartesianGrid stroke="var(--color-border)" vertical={false}/><XAxis dataKey="cell" hide/><YAxis stroke="var(--color-text-tertiary)"/><Tooltip/><Bar dataKey="seconds" fill="var(--color-dialect)" radius={[2,2,0,0]}/></BarChart></ResponsiveContainer></div></article>
        <article className="analysis-panel"><header><div><span>Stability between seeds</span><h2>Repeatability</h2></div></header><div className="stability-ledger">{Object.entries(analytics.stability).map(([engine, value]) => <div key={engine}><span>{engine}</span><meter min="0" max="1" value={value.repeatability}>{value.repeatability}</meter><strong>{Math.round(value.repeatability * 100)}%</strong><small>{value.distinct}/{value.samples} distinct</small></div>)}{!Object.keys(analytics.stability).length && <p>No repeated objective samples yet.</p>}</div></article>
        <article className="analysis-panel"><header><div><span>Convergence</span><h2>Search trace</h2></div></header><Empty title="Trace artifact not emitted" detail="When an engine returns its declared convergence trace, the run keeps it as a content-addressed artifact and renders it here." /></article>
      </div>
      <section className="cell-ledger">
        <header>
          <div><span>Provenance ledger</span><h2>Every plotted cell</h2></div>
          <small>{selection?.run.matrix_digest.slice(0, 24)}…</small>
        </header>
        <div>
          {cells.map((cell) => (
            <article
              key={cell.id}
              style={{ cursor: 'pointer' }}
              onClick={() => setInspectCell(cell)}
              title="Click to inspect study cell execution and objectives"
            >
              <span>{String(cell.ordinal + 1).padStart(3, '0')}</span>
              <strong>{cell.engine_ref.name}<small>{cell.engine_ref.mode ?? cell.engine_ref.version}</small></strong>
              <code>seed {cell.seed}</code>
              <span className={`run-state is-${cell.state}`}>{cell.state}</span>
              <button
                type="button"
                className="hash-badge"
                style={{ padding: '2px 6px', cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setInspectCell(cell);
                }}
                title="Inspect cell details"
              >
                <Eye size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Copy fingerprint"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard.writeText(cell.fingerprint);
                }}
              >
                <Copy aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      {/* Slide-over Drawer for Study Cell */}
      {inspectCell && (
        <EntityDrawer
          isOpen={Boolean(inspectCell)}
          onClose={() => setInspectCell(null)}
          title={`Study Cell #${inspectCell.ordinal + 1} · ${inspectCell.engine_ref.name}`}
          subtitle={`Fingerprint: ${inspectCell.fingerprint}`}
          badge={{
            label: inspectCell.state.toUpperCase(),
            variant: inspectCell.state === 'completed' ? 'completed' : inspectCell.state === 'failed' ? 'failed' : 'running',
          }}
          metadata={[
            { label: 'Ordinal', value: `#${inspectCell.ordinal + 1}` },
            { label: 'State', value: inspectCell.state },
            { label: 'Engine', value: `${inspectCell.engine_ref.namespace}/${inspectCell.engine_ref.name}` },
            { label: 'Version / Mode', value: `${inspectCell.engine_ref.version} (${inspectCell.engine_ref.mode ?? 'default'})` },
            { label: 'Seed', value: String(inspectCell.seed) },
            { label: 'Runtime', value: typeof inspectCell.metrics?.runtime_s === 'number' ? `${(inspectCell.metrics.runtime_s as number).toFixed(3)}s` : '—' },
            { label: 'Fingerprint', value: <code className="hash-badge" title={inspectCell.fingerprint}>{inspectCell.fingerprint.slice(0, 24)}…</code> },
          ]}
          jsonDocument={{
            id: inspectCell.id,
            study_run_id: inspectCell.study_run_id,
            ordinal: inspectCell.ordinal,
            state: inspectCell.state,
            engine: inspectCell.engine_ref,
            seed: inspectCell.seed,
            parameters: inspectCell.parameters,
            metrics: inspectCell.metrics,
            fingerprint: inspectCell.fingerprint,
          }}
        />
      )}
    </>}
  </div>;
}

export function ProjectRecordsPage({ kind }: { kind: 'reports' | 'artifacts' }) {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [reports, setReports] = useState<Report[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [runOptions, setRunOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [inspectReport, setInspectReport] = useState<Report | null>(null);
  const [inspectArtifact, setInspectArtifact] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organization || !project) return;
    setLoading(true);
    try {
      if (kind === 'artifacts') {
        setArtifacts(await platformApi.artifacts(organization.slug, project.slug));
        return;
      }
      const [nextReports, nextStudies, nextPublications] = await Promise.all([
        platformApi.reports(organization.slug, project.slug),
        platformApi.studies(organization.slug, project.slug),
        platformApi.publications(organization.slug, project.slug),
      ]);
      setReports(nextReports);
      setPublications(nextPublications);
      const nested = await Promise.all(
        nextStudies.map(async (study) =>
          (await platformApi.studyRuns(organization.slug, project.slug, study.slug)).map((run) => ({
            id: run.id,
            label: `${study.name} · run ${run.run_number} · ${run.state}`,
          }))
        )
      );
      setRunOptions(nested.flat());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `The ${kind} could not be loaded.`);
    } finally {
      setLoading(false);
    }
  }, [organization, project, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!organization || !project) return <NoProject />;
  const records = kind === 'reports' ? reports : artifacts;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy('create');
    try {
      const document = JSON.parse(String(form.get('document'))) as Record<string, unknown>;
      await platformApi.createReport(organization.slug, project.slug, {
        title: String(form.get('title')),
        slug: String(form.get('slug')),
        study_run_id: String(form.get('run') || '') || null,
        document,
      });
      event.currentTarget.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report creation failed.');
    } finally {
      setBusy(null);
    }
  };

  const freeze = async (report: Report) => {
    setBusy(report.id);
    setError(null);
    try {
      await platformApi.freezeReport(organization.slug, project.slug, report.slug);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report could not be frozen.');
    } finally {
      setBusy(null);
    }
  };

  const publish = async (report: Report) => {
    setBusy(report.id);
    setError(null);
    try {
      await platformApi.publishReport(organization.slug, project.slug, {
        report_id: report.id,
        slug: report.slug,
        citation: { title: report.title, digest: report.digest },
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report could not be published.');
    } finally {
      setBusy(null);
    }
  };

  const saveBytes = (bytes: ArrayBuffer, name: string, mediaType: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('artifact');
    if (!(file instanceof File) || !file.size) {
      setError('Choose a file to upload.');
      return;
    }
    setBusy('upload');
    setError(null);
    setNotice(null);
    try {
      await platformApi.uploadArtifact(organization.slug, project.slug, file, form.get('public') === 'on');
      event.currentTarget.reset();
      setNotice(`${file.name} is stored by digest.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The artifact could not be uploaded.');
    } finally {
      setBusy(null);
    }
  };

  const downloadArtifact = async (artifact: Artifact) => {
    setBusy(artifact.id);
    setError(null);
    try {
      saveBytes(
        await platformApi.downloadArtifact(organization.slug, project.slug, artifact.digest),
        artifact.digest,
        artifact.media_type
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The artifact could not be downloaded.');
    } finally {
      setBusy(null);
    }
  };

  const exportPackage = async () => {
    setBusy('export');
    setError(null);
    try {
      saveBytes(
        await platformApi.exportPackage(organization.slug, project.slug),
        `${project.slug}.openbinding.zip`,
        'application/zip'
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The portable package could not be exported.');
    } finally {
      setBusy(null);
    }
  };

  const importPackage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('package');
    if (!(file instanceof File) || !file.size) {
      setError('Choose an OpenBinding ZIP package.');
      return;
    }
    setBusy('import');
    setError(null);
    setNotice(null);
    try {
      const result = await platformApi.importPackage(organization.slug, project.slug, file);
      event.currentTarget.reset();
      setNotice(`Imported ${result.casesCreated} cases and ${result.revisionsCreated} immutable revisions.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The portable package could not be imported.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="platform-page">
      <PageHeading
        eyebrow="Reproducibility"
        title={kind === 'reports' ? 'Reports' : 'Artifacts'}
        detail={
          kind === 'reports'
            ? 'Freeze a human-readable analysis with exact BIM, engine, dataset and parameter provenance.'
            : 'Content-addressed files use immutable public URLs or authenticated private delivery.'
        }
      />
      {error && <p className="platform-form-error" role="alert">{error}</p>}
      {notice && <p className="platform-form-notice" role="status">{notice}</p>}

      {kind === 'artifacts' && (
        <section className="artifact-transfer" aria-labelledby="artifact-transfer-heading">
          <header>
            <div>
              <span>Portable evidence</span>
              <h2 id="artifact-transfer-heading">Move files without losing provenance</h2>
              <p>Artifacts keep their content digest. Project packages carry the manifest, cases, revisions, reports and referenced files.</p>
            </div>
            <button type="button" onClick={() => void exportPackage()} disabled={busy === 'export'}>
              <ArrowDownToLine aria-hidden="true" />
              {busy === 'export' ? 'Exporting…' : 'Export project ZIP'}
            </button>
          </header>
          <div>
            <form onSubmit={upload}>
              <label>
                Artifact file
                <input type="file" name="artifact" required />
              </label>
              <label className="artifact-public">
                <input type="checkbox" name="public" /> Publish by immutable digest
              </label>
              <button disabled={busy === 'upload'}>
                <ArrowUpFromLine aria-hidden="true" />
                {busy === 'upload' ? 'Uploading…' : 'Upload artifact'}
              </button>
            </form>
            <form onSubmit={importPackage}>
              <label>
                OpenBinding package
                <input type="file" name="package" accept=".zip,application/zip" required />
              </label>
              <small>Import creates missing cases and checksum-verified revisions. Existing matching revisions are skipped.</small>
              <button disabled={busy === 'import'}>
                <ArrowUpFromLine aria-hidden="true" />
                {busy === 'import' ? 'Importing…' : 'Import project ZIP'}
              </button>
            </form>
          </div>
        </section>
      )}

      {loading && <p className="record-loading" role="status">Reading {kind}…</p>}

      <div className="record-ledger">
        {kind === 'reports'
          ? reports.map((item) => {
              const publication = publications.find((candidate) => candidate.report_id === item.id);
              return (
                <article
                  key={item.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setInspectReport(item)}
                  title="Click to inspect report document and provenance"
                >
                  <FileArchive />
                  <div>
                    <span className={`hash-badge ${item.state === 'frozen' ? 'glow-completed' : 'glow-running'}`}>
                      {publication ? 'published' : item.state}
                    </span>
                    <h2>
                      <Link
                        to={`/app/${organization.slug}/${project.slug}/reports/${item.slug}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                        onClick={(e) => e.stopPropagation()}
                        title="Open full dedicated report view"
                      >
                        {item.title}
                      </Link>
                    </h2>
                    <code>{item.digest ? `${item.digest.slice(0, 24)}…` : 'Unfrozen draft'}</code>
                  </div>
                  <small>{new Date(item.created_at).toLocaleDateString()}</small>
                  <div className="record-actions" onClick={(e) => e.stopPropagation()}>
                    <Link
                      to={`/app/${organization.slug}/${project.slug}/reports/${item.slug}`}
                      className="hash-badge"
                      style={{ textDecoration: 'none', padding: '4px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      title="Open dedicated full page report view"
                    >
                      <FileText size={12} /> Full View
                    </Link>
                    <button
                      type="button"
                      onClick={() => setInspectReport(item)}
                      title="Inspect details and document"
                    >
                      <Eye size={13} aria-hidden="true" /> Inspect
                    </button>
                    {item.state === 'draft' && (
                      <button disabled={busy === item.id} onClick={() => void freeze(item)}>
                        <LockKeyhole size={13} aria-hidden="true" /> Freeze
                      </button>
                    )}
                    {item.state === 'frozen' && !publication && (
                      <button disabled={busy === item.id} onClick={() => void publish(item)}>
                        <Globe2 aria-hidden="true" /> Publish
                      </button>
                    )}
                    {publication && (
                      <span className="hash-badge" style={{ color: 'var(--color-accent)' }}>
                        <Globe2 aria-hidden="true" size={13} /> /{publication.slug}
                      </span>
                    )}
                  </div>
                </article>
              );
            })
          : artifacts.map((item) => {
              const isZip = item.media_type === 'application/zip' || item.media_type === 'application/x-zip-compressed' || item.digest.endsWith('.zip');
              return (
                <article
                  key={item.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setInspectArtifact(item)}
                  title={isZip ? 'Click to inspect and decompress artifact files' : 'Click to inspect artifact content'}
                >
                  <FileArchive />
                  <div>
                    <span className={`hash-badge ${item.public ? 'glow-completed' : ''}`}>
                      {item.public ? 'public' : 'private'} · {item.media_type}
                    </span>
                    <h2>{item.digest.slice(0, 24)}…</h2>
                    <code>{(item.size_bytes / 1024).toFixed(1)} KB</code>
                  </div>
                  <small>{new Date(item.created_at).toLocaleDateString()}</small>
                  <div className="record-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setInspectArtifact(item)}
                      title={isZip ? 'Inspect & decompress ZIP in browser' : 'Inspect document content'}
                    >
                      {isZip ? <Archive size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                      {isZip ? ' Inspect & Decompress' : ' Inspect Content'}
                    </button>
                    <button
                      type="button"
                      disabled={busy === item.id}
                      onClick={() => void downloadArtifact(item)}
                    >
                      <ArrowDownToLine aria-hidden="true" />
                      {busy === item.id ? 'Preparing…' : 'Download'}
                    </button>
                  </div>
                </article>
              );
            })}
      </div>

      {!loading && !records.length && (
        <Empty
          title={`No ${kind} yet`}
          detail={
            kind === 'reports'
              ? 'Create a report from a study run, then freeze it before publication.'
              : 'Upload a result or import a portable project package to begin the evidence ledger.'
          }
        />
      )}

      {kind === 'reports' && (
        <details className="report-builder">
          <summary>
            <Plus aria-hidden="true" /> Draft report
          </summary>
          <form onSubmit={create}>
            <label>
              Title
              <input name="title" required />
            </label>
            <label>
              Slug
              <input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
            </label>
            <label>
              Study run
              <select name="run" defaultValue="">
                <option value="">No run pinned</option>
                {runOptions.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="report-document">
              Report document (JSON)
              <textarea
                name="document"
                rows={8}
                required
                spellCheck={false}
                defaultValue={'{\n  "summary": "",\n  "findings": [],\n  "provenance": {}\n}'}
              />
            </label>
            <button disabled={busy === 'create'}>
              {busy === 'create' ? 'Creating…' : 'Create draft'}
            </button>
          </form>
        </details>
      )}

      {/* Slide-over Drawer for Report */}
      {inspectReport && (() => {
        const pub = publications.find((c) => c.report_id === inspectReport.id);
        const isDraft = inspectReport.state === 'draft';
        const actionsList: Array<{
          label: string;
          icon?: ReactNode;
          onClick: () => Promise<void>;
          variant?: 'primary' | 'secondary' | 'danger';
          disabled?: boolean;
          title?: string;
        }> = [];

        if (isDraft) {
          actionsList.push({
            label: busy === inspectReport.id ? 'Freezing…' : 'Freeze Report',
            icon: <LockKeyhole size={13} />,
            variant: 'primary',
            disabled: busy === inspectReport.id,
            title: 'Freeze report with exact immutable provenance',
            onClick: async () => {
              await freeze(inspectReport);
              setInspectReport(null);
            },
          });
        } else if (!pub) {
          actionsList.push({
            label: busy === inspectReport.id ? 'Publishing…' : 'Publish Report',
            icon: <Globe2 size={13} />,
            variant: 'primary',
            disabled: busy === inspectReport.id,
            title: 'Publish frozen report to public ledger',
            onClick: async () => {
              await publish(inspectReport);
              setInspectReport(null);
            },
          });
        }

        if (pub) {
          actionsList.push({
            label: 'Delete Publication',
            icon: <Trash2 size={13} />,
            variant: 'danger',
            title: 'Remove public publication link for this report',
            onClick: async () => {
              if (window.confirm(`Permanently unpublish / delete publication "${pub.slug}"?`)) {
                await platformApi.deletePublication(organization.slug, project.slug, pub.slug);
                await load();
                setInspectReport(null);
              }
            },
          });
        }

        return (
          <EntityDrawer
            isOpen={Boolean(inspectReport)}
            onClose={() => setInspectReport(null)}
            title={inspectReport.title}
            subtitle={`Report Slug: ${inspectReport.slug}`}
            fullPageUrl={`/app/${organization.slug}/${project.slug}/reports/${inspectReport.slug}`}
            badge={{
              label: pub ? 'PUBLISHED' : inspectReport.state.toUpperCase(),
              variant: inspectReport.state === 'frozen' ? 'completed' : 'running',
            }}
            metadata={[
              { label: 'Slug', value: inspectReport.slug },
              { label: 'Title', value: inspectReport.title },
              { label: 'State', value: pub ? 'Published' : inspectReport.state },
              {
                label: 'Digest',
                value: inspectReport.digest ? (
                  <code className="hash-badge" title={inspectReport.digest}>
                    {inspectReport.digest.slice(0, 20)}…
                  </code>
                ) : (
                  'Draft (unfrozen)'
                ),
              },
              { label: 'Pinned Study Run', value: inspectReport.study_run_id || 'None pinned' },
              { label: 'Created At', value: new Date(inspectReport.created_at).toLocaleString() },
              ...(pub
                ? [
                    { label: 'Publication Slug', value: `/${pub.slug}` },
                    { label: 'Publication DOI', value: (pub.citation?.doi as string | undefined) || 'None' },
                  ]
                : []),
            ]}
            jsonDocument={inspectReport.document}
            editable={
              isDraft
                ? {
                    fields: [
                      { key: 'title', label: 'Report Title', initialValue: inspectReport.title },
                      {
                        key: 'document',
                        label: 'Report Document (JSON)',
                        type: 'textarea',
                        initialValue: JSON.stringify(inspectReport.document, null, 2),
                      },
                    ],
                    onSave: async (vals) => {
                      await platformApi.updateReport(organization.slug, project.slug, inspectReport.slug, {
                        title: vals.title,
                        document: JSON.parse(vals.document) as Record<string, unknown>,
                      });
                      await load();
                    },
                  }
                : undefined
            }
            deletable={{
              confirmMessage: `Permanently delete report "${inspectReport.title}"?`,
              onDelete: async () => {
                await platformApi.deleteReport(organization.slug, project.slug, inspectReport.slug);
                await load();
              },
            }}
            actions={actionsList}
          />
        );
      })()}

      {/* Slide-over Drawer for Artifact */}
      {inspectArtifact && (
        <EntityDrawer
          isOpen={Boolean(inspectArtifact)}
          onClose={() => setInspectArtifact(null)}
          title={`Artifact ${inspectArtifact.digest.slice(0, 16)}…`}
          subtitle={`Digest: ${inspectArtifact.digest}`}
          badge={{
            label: inspectArtifact.public ? 'PUBLIC' : 'PRIVATE',
            variant: inspectArtifact.public ? 'completed' : 'default',
          }}
          metadata={[
            {
              label: 'Digest',
              value: <code className="hash-badge" title={inspectArtifact.digest}>{inspectArtifact.digest}</code>,
            },
            {
              label: 'Visibility',
              value: inspectArtifact.public ? 'Public (Immutable digest URL)' : 'Private (Authenticated delivery)',
            },
            { label: 'Media Type', value: inspectArtifact.media_type },
            {
              label: 'File Size',
              value: `${(inspectArtifact.size_bytes / 1024).toFixed(2)} KB (${inspectArtifact.size_bytes.toLocaleString()} bytes)`,
            },
            { label: 'Created At', value: new Date(inspectArtifact.created_at).toLocaleString() },
            {
              label: 'Direct Delivery URL',
              value: (
                <code className="hash-badge" style={{ fontSize: '0.75rem' }}>
                  /v1/organizations/{organization.slug}/projects/{project.slug}/artifacts/{inspectArtifact.digest}
                </code>
              ),
            },
          ]}
          fetchArchiveBlob={() => platformApi.downloadArtifact(organization.slug, project.slug, inspectArtifact.digest)}
          archiveFilename={
            (inspectArtifact.media_type === 'application/zip' || inspectArtifact.media_type === 'application/x-zip-compressed' || inspectArtifact.digest.endsWith('.zip'))
              ? `${inspectArtifact.digest.slice(0, 12)}.zip`
              : `${inspectArtifact.digest.slice(0, 12)}.${inspectArtifact.media_type === 'application/json' ? 'json' : inspectArtifact.media_type === 'text/csv' ? 'csv' : 'txt'}`
          }
          deletable={{
            confirmMessage: `Permanently delete artifact "${inspectArtifact.digest.slice(0, 20)}…"?`,
            onDelete: async () => {
              await platformApi.deleteArtifact(organization.slug, project.slug, inspectArtifact.digest);
              await load();
            },
          }}
          actions={[
            {
              label: 'Download File',
              icon: <ArrowDownToLine size={13} />,
              onClick: () => {
                void downloadArtifact(inspectArtifact);
              },
            },
            {
              label: 'Copy Digest',
              icon: <Copy size={13} />,
              onClick: () => {
                void navigator.clipboard.writeText(inspectArtifact.digest);
                setNotice(`Copied digest: ${inspectArtifact.digest}`);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
