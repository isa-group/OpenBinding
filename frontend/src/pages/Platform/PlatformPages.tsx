import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowRight, ArrowUpFromLine, Braces, CheckCircle2, CircleDashed, CircleStop, Clock3, Copy, Database, FileArchive, FlaskConical,
  FolderKanban, GitCompareArrows, Globe2, History, Library, LockKeyhole, Network, Plus,
  RefreshCw, Rocket, ShieldCheck, Sparkles, TriangleAlert, UserRoundPlus, Users,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createOrganization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCreating(true);
    setError(null);
    try {
      await platformApi.createOrganization({
        name: String(form.get('name')), slug: String(form.get('slug')),
        parent_id: String(form.get('parent') || '') || null,
      });
      event.currentTarget.reset();
      await context.reload();
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

    <section className="platform-section">
      <div className="section-title"><div><span>Organizations</span><h2>Spaces you can reach</h2></div><small>{context.organizations.length} visible</small></div>
      {context.organizations.length ? <div className="workspace-card-grid">{context.organizations.map((organization) => {
        const projects = organization.id === context.organization?.id ? context.projects : [];
        return <article key={organization.id} className="workspace-card">
          <header><span>{organization.name.slice(0, 2).toUpperCase()}</span><small>{organization.effective_role}</small></header>
          <h3>{organization.name}</h3><code>{organization.slug}</code>
          <div>{projects.slice(0, 3).map((project) => <Link key={project.id} to={`/app/${organization.slug}/${project.slug}`}><FolderKanban aria-hidden="true" /><span>{project.name}<small>{project.visibility}</small></span><ArrowRight aria-hidden="true" /></Link>)}</div>
          <Link className="card-footer-link" to={`/app/${organization.slug}`}>Open organization <ArrowRight aria-hidden="true" /></Link>
        </article>;
      })}</div> : <Empty title="Create the first organization" detail="Organizations own projects, invite members and provide the sponsor contract boundary." />}
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
  </div>;
}

export function OrganizationSettingsPage() {
  const context = useOutletContext<PlatformOutletContext>();
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
  </div>;
}

export function ProjectOverview() {
  const context = useOutletContext<PlatformOutletContext>();
  const { organization, project } = context;
  const [cases, setCases] = useState<BindingCase[]>([]);
  const [studies, setStudies] = useState<Study[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);

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
  </div>;
}

function NoProject() {
  const context = useOutletContext<PlatformOutletContext>();
  const [error, setError] = useState<string | null>(null);
  if (!context.organization) return <div className="platform-page"><Empty title="No organization yet" detail="Create an organization from the activity page first." /></div>;
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      await platformApi.createProject(context.organization!.slug, {
        name: String(form.get('name')), slug: String(form.get('slug')),
        description: String(form.get('description') || ''), visibility: 'private',
      }); await context.reload();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Project creation failed.'); }
  };
  return <div className="platform-page"><PageHeading eyebrow={context.organization.name} title="Create a first project" detail="Projects isolate cases, studies, artifacts and permissions." />
    <form className="standalone-form" onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label>{error && <p role="alert">{error}</p>}<button>Create private project</button></form>
  </div>;
}

export function CasesPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [cases, setCases] = useState<BindingCase[]>([]);
  const [revisions, setRevisions] = useState<Record<string, CaseRevision[]>>({});
  const [error, setError] = useState<string | null>(null);
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
  return <div className="platform-page"><PageHeading eyebrow="Project resources" title="Binding cases" detail="A case is the durable identity; each edit creates an immutable revision pinned to its source snapshot." />
    {error && <p className="platform-form-error" role="alert">{error}</p>}
    <div className="case-grid">{cases.map((item) => <article key={item.id}><header><span>{item.slug}</span><LockKeyhole aria-label="Immutable revisions" /></header><h2>{item.name}</h2><p>{item.description || 'No description yet.'}</p><div className="case-revisions"><strong><History aria-hidden="true" /> {revisions[item.id]?.length ?? 0} revisions</strong>{revisions[item.id]?.slice(0, 2).map((revision) => <code key={revision.id}>r{revision.revision} · {revision.digest.slice(0, 18)}…</code>)}<details><summary>Attach JSON revision</summary><form onSubmit={(event) => void createRevision(event, item)}><label>Case document<textarea name="document" required rows={6} spellCheck={false} placeholder={'{\n  "apiVersion": "bim/v1",\n  "kind": "Instance",\n  "metadata": { "name": "example" },\n  "spec": { "profile": "qos-binding/v1", "resources": {} }\n}'} /></label><label>Executable snapshot UUID <small>optional</small><input name="source_snapshot_id" type="text" inputMode="text" pattern="[0-9a-fA-F-]{36}" placeholder="Created by the workbench before solving" /></label><button>Create immutable revision</button></form></details></div><footer><small>{new Date(item.created_at).toLocaleDateString()}</small><Link to="../workbench">Open in workbench <ArrowRight aria-hidden="true" /></Link></footer></article>)}</div>
    {!cases.length && <Empty title="No cases yet" detail="Create a durable identity, then attach BIM snapshots as immutable revisions." />}
    <details className="inline-create-panel"><summary><Plus aria-hidden="true" /> New binding case</summary><form onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label>{error && <p role="alert">{error}</p>}<button>Create case</button></form></details>
  </div>;
}

export function ResourcesPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [resources, setResources] = useState<ProjectResource[]>([]);
  const [revisions, setRevisions] = useState<Record<string, ProjectResourceRevision[]>>({});
  const [error, setError] = useState<string | null>(null);
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

  return <div className="platform-page resources-page"><PageHeading eyebrow="Reusable project material" title="Resources" detail="Catalogues, datasets, constraints and other supporting documents keep their own immutable, digest-addressed revision history." />
    {error && <p className="platform-form-error" role="alert">{error}</p>}
    <div className="case-grid">{resources.map((resource) => <article key={resource.id}><header><span>{resource.kind}</span><Database aria-label="Versioned resource" /></header><h2>{resource.name}</h2><p>{resource.description || resource.slug}</p><div className="case-revisions"><strong><History aria-hidden="true" /> {revisions[resource.id]?.length ?? 0} revisions</strong>{revisions[resource.id]?.slice(-2).reverse().map((revision) => <code key={revision.id}>r{revision.revision} · {revision.digest.slice(0, 18)}…</code>)}<details><summary>Attach JSON revision</summary><form onSubmit={(event) => void addRevision(event, resource)}><label>Resource document<textarea name="document" required rows={7} spellCheck={false} placeholder={'{\n  "apiVersion": "openbinding.dev/qos-binding/v1",\n  "kind": "CandidateCatalog",\n  "spec": {}\n}'} /></label><button>Create immutable revision</button></form></details></div><footer><small>{resource.slug}</small><LockKeyhole aria-label="Immutable by digest" /></footer></article>)}</div>
    {!resources.length && <Empty title="No project resources" detail="Create a named resource, then attach checksum-verified revisions for collections and reproducible packages." />}
    <details className="inline-create-panel"><summary><Plus aria-hidden="true" /> New project resource</summary><form onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Kind<input name="kind" defaultValue="bim-resource" required /></label><label>Description<textarea name="description" rows={3} /></label><button>Create resource</button></form></details>
  </div>;
}

export function CollectionsPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [revisions, setRevisions] = useState<Record<string, CollectionRevision[]>>({});
  const [error, setError] = useState<string | null>(null);
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

  return <div className="platform-page collections-page"><PageHeading eyebrow="Curated evidence" title="Collections" detail="A collection is an ordered, versioned set of immutable case, resource, result or report references. It never executes work; a study may pin one of its revisions as input." />
    {error && <p className="platform-form-error" role="alert">{error}</p>}
    <div className="collection-grid">{collections.map((collection) => { const latest = revisions[collection.id]?.[0]; return <article key={collection.id}><header><Library aria-hidden="true" /><span>{collection.slug}</span><small>{revisions[collection.id]?.length ?? 0} revisions</small></header><h2>{collection.name}</h2><p>{collection.description || 'No description yet.'}</p>{latest ? <div className="collection-latest"><span>Latest revision</span><strong>r{latest.revision} · {latest.items.length} references</strong><code>{latest.digest}</code></div> : <div className="collection-latest is-empty">No curated revision yet.</div>}<details><summary><Plus aria-hidden="true" /> New immutable revision</summary><form onSubmit={(event) => void addRevision(event, collection)}><label>Ordered reference array<textarea name="items" required rows={8} spellCheck={false} placeholder={'[\n  {\n    "target_kind": "case",\n    "target_digest": "sha256-…",\n    "target_ref": { "case": "checkout", "revision": 3 }\n  }\n]'} /></label><button>Create revision</button></form></details></article>; })}</div>
    {!collections.length && <Empty title="No collections yet" detail="Create one when you need a stable, curated corpus across cases, resources or published results." />}
    <details className="inline-create-panel"><summary><Plus aria-hidden="true" /> New collection</summary><form onSubmit={create}><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label><button>Create collection</button></form></details>
  </div>;
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
  return <div className="platform-page"><PageHeading eyebrow="Reproducible experiments" title="Comparative studies" detail="Each run freezes the Cartesian matrix of case revisions, engine revisions, parameter sets and seeds before dispatch." />
    {error && <p className="platform-form-error" role="alert">{error}</p>}
    <div className="study-list">{studies.map((study) => {
      const latest = runs[study.id]?.[0]; const cells = study.definition.case_revision_ids.length * study.definition.engines.length * study.definition.parameter_sets.length * study.definition.seeds.length;
      const retryable = latest ? (runCells[latest.id] ?? []).filter((cell) => cell.state === 'failed' || cell.state === 'cancelled') : [];
      return <article key={study.id}><div className="study-index"><FlaskConical aria-hidden="true" /><span>{cells}<small>cells</small></span></div><div><span className="status-chip">{study.state}</span><h2>{study.name}</h2><p>{study.description || 'Exact comparative matrix.'}</p><div className="study-formula"><code>{study.definition.case_revision_ids.length} cases</code><b>×</b><code>{study.definition.engines.length} engines</code><b>×</b><code>{study.definition.parameter_sets.length} parameters</code><b>×</b><code>{study.definition.seeds.length} seeds</code></div>{latest && retryable.length > 0 && <details className="study-retries"><summary>{retryable.length} retryable cell{retryable.length === 1 ? '' : 's'}</summary><div>{retryable.map((cell) => <button key={cell.id} type="button" disabled={running !== null} onClick={() => void retry(study, latest, cell)}><RefreshCw aria-hidden="true" /> Cell {cell.ordinal + 1} · {running === `retry:${cell.id}` ? 'retrying…' : cell.state}</button>)}</div></details>}</div><aside>{latest ? <><small>Latest run #{latest.run_number}</small><strong className={`run-state is-${latest.state}`}>{latest.state}</strong><Link to="../analytics">Inspect analysis <ArrowRight aria-hidden="true" /></Link>{(latest.state === 'queued' || latest.state === 'running') && <button className="study-cancel" type="button" onClick={() => void cancel(study, latest)} disabled={running !== null}><CircleStop aria-hidden="true" />{running === `cancel:${latest.id}` ? 'Cancelling…' : 'Cancel run'}</button>}</> : <small>Never run</small>}<button type="button" onClick={() => void execute(study)} disabled={running !== null}><RefreshCw aria-hidden="true" />{running === study.id ? 'Dispatching…' : 'Run matrix'}</button></aside></article>;
    })}</div>
    {!studies.length && <Empty title="No study definitions" detail="Create a study from a case after choosing exact compatible engine revisions and seeds." action={<Link to="../cases">Choose a case</Link>} />}
    <details className="study-builder"><summary><Plus aria-hidden="true" /> Define comparative study</summary><form onSubmit={create}><div className="study-builder-fields"><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label></div><div className="study-builder-matrix"><fieldset><legend>Executable case revisions</legend>{cases.map((item) => { const revision = caseRevisions[item.id]?.find((candidate) => candidate.source_snapshot_id); return <label key={item.id} className={!revision ? 'is-disabled' : undefined}><input type="checkbox" disabled={!revision} checked={Boolean(revision && selectedRevisions.includes(revision.id))} onChange={() => revision && setSelectedRevisions((current) => current.includes(revision.id) ? current.filter((id) => id !== revision.id) : [...current, revision.id])} /><span><strong>{item.name}</strong><small>{revision ? `r${revision.revision} · ${revision.digest.slice(0, 15)}…` : 'Attach a revision backed by a BIM snapshot first'}</small></span></label>; })}{!cases.length && <p>No binding cases yet.</p>}</fieldset><fieldset><legend>Exact Engine modes</legend>{engineChoices.map(({ engine, mode, key }) => <label key={key}><input type="checkbox" checked={selectedEngines.includes(key)} onChange={() => setSelectedEngines((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} /><span><strong>{engine.namespace}/{engine.name}</strong><small>{engine.version} · {mode.id} · {engine.digest.slice(0, 12)}…</small></span></label>)}{!engineChoices.length && <p>No compatible engines visible.</p>}</fieldset></div><div className="study-builder-options"><label>Parameter sets (JSON array)<textarea name="parameters" rows={5} defaultValue="[{}]" spellCheck={false} /></label><label>Seeds<input name="seeds" defaultValue="0" placeholder="0, 1, 2" /></label><output>{selectedRevisions.length || 0} × {selectedEngines.length || 0} × parameters × seeds</output><button>Create immutable definition</button></div></form></details>
  </div>;
}

export function AnalyticsPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [studies, setStudies] = useState<Study[]>([]);
  const [selection, setSelection] = useState<{ study: Study; run: StudyRun } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [cells, setCells] = useState<StudyCell[]>([]);
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
      <div className="analysis-kpis"><article><CheckCircle2 /><small>Feasible</small><strong>{analytics.feasible}</strong><span>of {analytics.cells} cells</span></article><article><TriangleAlert /><small>Failed</small><strong>{analytics.failed}</strong><span>retryable cells</span></article><article><Clock3 /><small>Median runtime</small><strong>{analytics.runtimes_s.length ? `${analytics.runtimes_s[Math.floor(analytics.runtimes_s.length / 2)].toFixed(2)}s` : '—'}</strong><span>end-to-end</span></article><article><Sparkles /><small>Pareto front</small><strong>{analytics.pareto.length}</strong><span>nondominated points</span></article></div>
      <div className="analysis-grid">
        <article className="analysis-panel pareto-panel"><header><div><span>Pareto explorer</span><h2>{objectiveKeys.length > 1 ? `${objectiveKeys[0]} × ${objectiveKeys[1]}` : 'Objective frontier'}</h2></div><small>minimize · exact cell results</small></header><div className="chart-frame">{scatter.length ? <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 20, right: 25, bottom: 25, left: 10 }}><CartesianGrid stroke="var(--color-border)" strokeDasharray="2 5"/><XAxis type="number" dataKey="x" name={objectiveKeys[0]} stroke="var(--color-text-tertiary)"/><YAxis type="number" dataKey="y" name={objectiveKeys[1]} stroke="var(--color-text-tertiary)"/><Tooltip cursor={{ strokeDasharray: '3 3' }}/><Scatter data={scatter} fill="var(--color-accent)" /></ScatterChart></ResponsiveContainer> : <Empty title="No objective points" detail="Completed feasible solutions with numeric objectives appear here." />}</div></article>
        <article className="analysis-panel"><header><div><span>Runtime distribution</span><h2>Cost of evidence</h2></div></header><div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><BarChart data={analytics.runtimes_s.map((value, index) => ({ cell: index + 1, seconds: value }))}><CartesianGrid stroke="var(--color-border)" vertical={false}/><XAxis dataKey="cell" hide/><YAxis stroke="var(--color-text-tertiary)"/><Tooltip/><Bar dataKey="seconds" fill="var(--color-dialect)" radius={[2,2,0,0]}/></BarChart></ResponsiveContainer></div></article>
        <article className="analysis-panel"><header><div><span>Stability between seeds</span><h2>Repeatability</h2></div></header><div className="stability-ledger">{Object.entries(analytics.stability).map(([engine, value]) => <div key={engine}><span>{engine}</span><meter min="0" max="1" value={value.repeatability}>{value.repeatability}</meter><strong>{Math.round(value.repeatability * 100)}%</strong><small>{value.distinct}/{value.samples} distinct</small></div>)}{!Object.keys(analytics.stability).length && <p>No repeated objective samples yet.</p>}</div></article>
        <article className="analysis-panel"><header><div><span>Convergence</span><h2>Search trace</h2></div></header><Empty title="Trace artifact not emitted" detail="When an engine returns its declared convergence trace, the run keeps it as a content-addressed artifact and renders it here." /></article>
      </div>
      <section className="cell-ledger"><header><div><span>Provenance ledger</span><h2>Every plotted cell</h2></div><small>{selection?.run.matrix_digest.slice(0, 24)}…</small></header><div>{cells.map((cell) => <article key={cell.id}><span>{String(cell.ordinal + 1).padStart(3, '0')}</span><strong>{cell.engine_ref.name}<small>{cell.engine_ref.mode ?? cell.engine_ref.version}</small></strong><code>seed {cell.seed}</code><span className={`run-state is-${cell.state}`}>{cell.state}</span><button title="Copy fingerprint" onClick={() => void navigator.clipboard.writeText(cell.fingerprint)}><Copy aria-hidden="true" /></button></article>)}</div></section>
    </>}
  </div>;
}

export function ProjectRecordsPage({ kind }: { kind: 'reports' | 'artifacts' }) {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [reports, setReports] = useState<Report[]>([]); const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [runOptions, setRunOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!organization || !project) return;
    setLoading(true);
    try {
      if (kind === 'artifacts') { setArtifacts(await platformApi.artifacts(organization.slug, project.slug)); return; }
      const [nextReports, nextStudies, nextPublications] = await Promise.all([
        platformApi.reports(organization.slug, project.slug),
        platformApi.studies(organization.slug, project.slug),
        platformApi.publications(organization.slug, project.slug),
      ]);
      setReports(nextReports); setPublications(nextPublications);
      const nested = await Promise.all(nextStudies.map(async (study) => (await platformApi.studyRuns(organization.slug, project.slug, study.slug)).map((run) => ({ id: run.id, label: `${study.name} · run ${run.run_number} · ${run.state}` }))));
      setRunOptions(nested.flat());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `The ${kind} could not be loaded.`);
    } finally { setLoading(false); }
  }, [organization, project, kind]);
  useEffect(() => { void load(); }, [load]);
  if (!organization || !project) return <NoProject />;
  const records = kind === 'reports' ? reports : artifacts;
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError(null); setBusy('create');
    try {
      const document = JSON.parse(String(form.get('document'))) as Record<string, unknown>;
      await platformApi.createReport(organization.slug, project.slug, {
        title: String(form.get('title')), slug: String(form.get('slug')),
        study_run_id: String(form.get('run') || '') || null, document,
      });
      event.currentTarget.reset(); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Report creation failed.'); }
    finally { setBusy(null); }
  };
  const freeze = async (report: Report) => {
    setBusy(report.id); setError(null);
    try { await platformApi.freezeReport(organization.slug, project.slug, report.slug); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Report could not be frozen.'); }
    finally { setBusy(null); }
  };
  const publish = async (report: Report) => {
    setBusy(report.id); setError(null);
    try { await platformApi.publishReport(organization.slug, project.slug, { report_id: report.id, slug: report.slug, citation: { title: report.title, digest: report.digest } }); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Report could not be published.'); }
    finally { setBusy(null); }
  };
  const saveBytes = (bytes: ArrayBuffer, name: string, mediaType: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    URL.revokeObjectURL(url);
  };
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('artifact');
    if (!(file instanceof File) || !file.size) { setError('Choose a file to upload.'); return; }
    setBusy('upload'); setError(null); setNotice(null);
    try {
      await platformApi.uploadArtifact(organization.slug, project.slug, file, form.get('public') === 'on');
      event.currentTarget.reset(); setNotice(`${file.name} is stored by digest.`); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The artifact could not be uploaded.'); }
    finally { setBusy(null); }
  };
  const downloadArtifact = async (artifact: Artifact) => {
    setBusy(artifact.id); setError(null);
    try { saveBytes(await platformApi.downloadArtifact(organization.slug, project.slug, artifact.digest), artifact.digest, artifact.media_type); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The artifact could not be downloaded.'); }
    finally { setBusy(null); }
  };
  const exportPackage = async () => {
    setBusy('export'); setError(null);
    try { saveBytes(await platformApi.exportPackage(organization.slug, project.slug), `${project.slug}.openbinding.zip`, 'application/zip'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The portable package could not be exported.'); }
    finally { setBusy(null); }
  };
  const importPackage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget); const file = form.get('package');
    if (!(file instanceof File) || !file.size) { setError('Choose an OpenBinding ZIP package.'); return; }
    setBusy('import'); setError(null); setNotice(null);
    try {
      const result = await platformApi.importPackage(organization.slug, project.slug, file);
      event.currentTarget.reset(); setNotice(`Imported ${result.casesCreated} cases and ${result.revisionsCreated} immutable revisions.`); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The portable package could not be imported.'); }
    finally { setBusy(null); }
  };
  return <div className="platform-page"><PageHeading eyebrow="Reproducibility" title={kind === 'reports' ? 'Reports' : 'Artifacts'} detail={kind === 'reports' ? 'Freeze a human-readable analysis with exact BIM, engine, dataset and parameter provenance.' : 'Content-addressed files use immutable public URLs or authenticated private delivery.'} />
    {error && <p className="platform-form-error" role="alert">{error}</p>}
    {notice && <p className="platform-form-notice" role="status">{notice}</p>}
    {kind === 'artifacts' && <section className="artifact-transfer" aria-labelledby="artifact-transfer-heading">
      <header><div><span>Portable evidence</span><h2 id="artifact-transfer-heading">Move files without losing provenance</h2><p>Artifacts keep their content digest. Project packages carry the manifest, cases, revisions, reports and referenced files.</p></div><button type="button" onClick={() => void exportPackage()} disabled={busy === 'export'}><ArrowDownToLine aria-hidden="true" />{busy === 'export' ? 'Exporting…' : 'Export project ZIP'}</button></header>
      <div>
        <form onSubmit={upload}><label>Artifact file<input type="file" name="artifact" required /></label><label className="artifact-public"><input type="checkbox" name="public" /> Publish by immutable digest</label><button disabled={busy === 'upload'}><ArrowUpFromLine aria-hidden="true" />{busy === 'upload' ? 'Uploading…' : 'Upload artifact'}</button></form>
        <form onSubmit={importPackage}><label>OpenBinding package<input type="file" name="package" accept=".zip,application/zip" required /></label><small>Import creates missing cases and checksum-verified revisions. Existing matching revisions are skipped.</small><button disabled={busy === 'import'}><ArrowUpFromLine aria-hidden="true" />{busy === 'import' ? 'Importing…' : 'Import project ZIP'}</button></form>
      </div>
    </section>}
    {loading && <p className="record-loading" role="status">Reading {kind}…</p>}
    <div className="record-ledger">{kind === 'reports' ? reports.map((item) => { const publication = publications.find((candidate) => candidate.report_id === item.id); return <article key={item.id}><FileArchive /><div><span>{publication ? 'published' : item.state}</span><h2>{item.title}</h2><code>{item.digest}</code></div><small>{new Date(item.created_at).toLocaleDateString()}</small><div className="record-actions">{item.state === 'draft' && <button disabled={busy === item.id} onClick={() => void freeze(item)}>Freeze</button>}{item.state === 'frozen' && !publication && <button disabled={busy === item.id} onClick={() => void publish(item)}><Globe2 aria-hidden="true" /> Publish</button>}{publication && <span><Globe2 aria-hidden="true" /> /{publication.slug}</span>}</div></article>; }) : artifacts.map((item) => <article key={item.id}><FileArchive /><div><span>{item.public ? 'public' : 'private'} · {item.media_type}</span><h2>{item.digest.slice(0, 24)}…</h2><code>{(item.size_bytes / 1024).toFixed(1)} KB</code></div><small>{new Date(item.created_at).toLocaleDateString()}</small><div className="record-actions"><button type="button" disabled={busy === item.id} onClick={() => void downloadArtifact(item)}><ArrowDownToLine aria-hidden="true" />{busy === item.id ? 'Preparing…' : 'Download'}</button></div></article>)}</div>
    {!loading && !records.length && <Empty title={`No ${kind} yet`} detail={kind === 'reports' ? 'Create a report from a study run, then freeze it before publication.' : 'Upload a result or import a portable project package to begin the evidence ledger.'} />}
    {kind === 'reports' && <details className="report-builder"><summary><Plus aria-hidden="true" /> Draft report</summary><form onSubmit={create}><label>Title<input name="title" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Study run<select name="run" defaultValue=""><option value="">No run pinned</option>{runOptions.map((run) => <option key={run.id} value={run.id}>{run.label}</option>)}</select></label><label className="report-document">Report document (JSON)<textarea name="document" rows={8} required spellCheck={false} defaultValue={'{\n  "summary": "",\n  "findings": [],\n  "provenance": {}\n}'} /></label><button disabled={busy === 'create'}>{busy === 'create' ? 'Creating…' : 'Create draft'}</button></form></details>}
  </div>;
}
