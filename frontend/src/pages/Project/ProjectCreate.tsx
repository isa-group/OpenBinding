import { useId, useState, type FormEvent } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { Check, Globe2, Lock } from 'lucide-react';
import { apiClient } from '../../api/client';
import { platformApi } from '../../api/platform';
import type { Project, Visibility } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { sponsorName } from '../Organization/orgModel';
import { Breadcrumb, NeutralGate, PageSkeleton, RoleChip } from '../Organization/parts';
import { RoomBars } from '../Organization/room';
import { roomFromUsage } from '../Organization/roomModel';
import { createRefusal, type ProjectRefusal } from './projectErrors';
import { accessIn, DESCRIPTION_MAX, NAME_MAX, SLUG_PATTERN, slugFromName } from './projectModel';
import { VisibilityChip } from './parts';
import './Project.css';

const ROOM_FOR_PROJECT = ['projects', 'privateProjects'] as const;

const CHOICES: ReadonlyArray<{ value: Visibility; label: string; icon: typeof Lock; points: ReadonlyArray<[string, string]> }> = [
  { value: 'private', label: 'Private', icon: Lock, points: [['✓', 'Only members of the organization see it'], ['✓', 'Counts as a private project for the sponsor'], ['–', 'Not listed in Explore']] },
  { value: 'public', label: 'Public', icon: Globe2, points: [['✓', 'Its card appears in Explore'], ['✓', 'Published results can be verified by anyone'], ['–', 'Drafts and cases still need membership to open']] },
];

/** New project (`proj-create`, `/app/:org/new-project`): name, address, description and who can see it. */
export function ProjectCreate() {
  const context = useOutletContext<PlatformOutletContext>();
  const { org: orgSlug = '' } = useParams();
  const { user, isAdmin } = useAuth();
  const slugId = useId();
  const descriptionId = useId();
  const organization = context.organizations.find((item) => item.slug === orgSlug);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<ProjectRefusal | null>(null);
  const [created, setCreated] = useState<Project | null>(null);

  const sponsorIsMe = Boolean(organization && user && user.id === organization.billing_sponsor_user_id);
  const usage = useResource(`new-project-usage:${orgSlug}:${sponsorIsMe}`, () => (sponsorIsMe ? apiClient.getOwnUsage().catch(() => null) : Promise.resolve(null)));
  const people = useResource(`new-project-people:${orgSlug}`, () => (organization ? platformApi.members(orgSlug).catch(() => []) : Promise.resolve([])));

  if (!organization) {
    if (context.loading) return <div className="org-page is-sm"><PageSkeleton /></div>;
    return <div className="org-page is-sm"><NeutralGate /></div>;
  }

  const access = accessIn(organization, isAdmin);
  const viewerOnly = !access.canCreate;
  const isPrivate = visibility === 'private';
  const me = user ? { id: user.id, username: user.username } : null;
  const sponsor = sponsorName(organization, people.data ?? [], me);

  const slugValid = SLUG_PATTERN.test(slug);
  const slugTaken = context.projects.some((item) => item.slug === slug);
  const slugBad = Boolean(slug) && (!slugValid || slugTaken);
  const slugHelp = !slug
    ? 'Lowercase letters, numbers and hyphens.'
    : !slugValid
      ? 'Use lowercase letters, numbers and hyphens; start and end with a letter or number.'
      : slugTaken ? 'Already used in this organization.' : 'Looks good · can’t be changed later.';
  const valid = name.trim().length > 0 && slugValid && !slugTaken && !viewerOnly;

  const room = usage.data ? roomFromUsage(usage.data, ROOM_FOR_PROJECT, { projects: 1, privateProjects: isPrivate ? 1 : 0 }) : [];

  const typeName = (value: string) => {
    setName(value);
    setRefusal(null);
    if (!slugTouched) setSlug(slugFromName(value));
  };

  const create = async () => {
    setCreating(true);
    setRefusal(null);
    try {
      const project = await platformApi.createProject(orgSlug, { name: name.trim(), slug, description: description.trim(), visibility });
      await context.reload();
      setCreated(project);
    } catch (caught) {
      setRefusal(createRefusal(caught, { organization: organization.name, isPrivate }));
    } finally {
      setCreating(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || creating) return;
    void create();
  };

  const crumbs = [{ label: 'Home', to: '/app' }, { label: organization.name, to: `/app/${orgSlug}` }];

  if (created) {
    return (
      <div className="org-page is-sm">
        <Breadcrumb items={[...crumbs, { label: 'New project' }]} />
        <section className="org-done" role="status" aria-live="polite">
          <span className="org-done-mark" aria-hidden="true"><Check /></span>
          <div className="org-done-body">
            <strong>{created.name} is ready</strong>
            <span>
              {created.visibility === 'private'
                ? `Private: only members of ${organization.name} can see it.`
                : 'Public: its card now appears in Explore.'}
            </span>
          </div>
          <div className="org-done-actions">
            <Action to={`/app/${orgSlug}/${created.slug}`} variant="primary">Open project</Action>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="org-page is-sm">
      <Breadcrumb items={[...crumbs, { label: 'New project' }]} />
      <header className="org-head">
        <div>
          <h1>New project in {organization.name}</h1>
          <p>A project holds the cases, runs, studies and reports for one piece of work.</p>
        </div>
      </header>

      {viewerOnly && (
        <div className="proj-note" role="note">
          <span>
            You’re {organization.effective_role ? <>a <b>{organization.effective_role}</b></> : 'not a member'} in {organization.name}, so you can look at this form but not create a project (403).
            A MEMBER or above can; ask an admin in <Link to={`/app/${orgSlug}/settings/members`}>Members</Link>.
          </span>
        </div>
      )}

      <form className="proj-create" onSubmit={submit} noValidate>
        <div className="proj-create-main">
          <section className="proj-card" aria-labelledby="pc-about">
            <h2 id="pc-about">About the project</h2>
            <FormField
              label="Name"
              value={name}
              onChange={(event) => typeName(event.target.value)}
              disabled={viewerOnly}
              maxLength={NAME_MAX}
            />
            <div className="ui-field">
              <label htmlFor={slugId}>Address</label>
              <div className={`org-slug${slugBad ? ' is-invalid' : ''}`}>
                <span aria-hidden="true" className="proj-slug-prefix">/app/{orgSlug}/</span>
                <input
                  id={slugId}
                  value={slug}
                  onChange={(event) => { setSlug(event.target.value); setSlugTouched(true); setRefusal(null); }}
                  disabled={viewerOnly}
                  spellCheck={false}
                  aria-invalid={slugBad || undefined}
                  aria-describedby={`${slugId}-help`}
                />
              </div>
              <span id={`${slugId}-help`} className={`ui-field-note${slugBad ? ' is-error' : ''}`}>{slugHelp}</span>
            </div>
            <div className="ui-field">
              <label htmlFor={descriptionId}>Description <span className="proj-optional">(optional)</span></label>
              <textarea
                id={descriptionId}
                className="proj-textarea"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={viewerOnly}
                maxLength={DESCRIPTION_MAX}
                rows={3}
              />
              <span className="ui-field-note">{description.length.toLocaleString('en-US')} / {DESCRIPTION_MAX.toLocaleString('en-US')}</span>
            </div>
          </section>

          <section className="proj-card" aria-labelledby="pc-vis">
            <h2 id="pc-vis">Who can see it</h2>
            <fieldset className="proj-vis" disabled={viewerOnly}>
              <legend className="sr-only">Visibility</legend>
              {CHOICES.map((choice) => {
                const Icon = choice.icon;
                const checked = visibility === choice.value;
                return (
                  <label key={choice.value} className={`proj-vis-card${checked ? ' is-checked' : ''}`}>
                    <input type="radio" name="visibility" value={choice.value} checked={checked} onChange={() => { setVisibility(choice.value); setRefusal(null); }} />
                    <span className="proj-vis-head">
                      <span className="proj-vis-icon" aria-hidden="true"><Icon /></span>
                      <strong>{choice.label}</strong>
                    </span>
                    {choice.points.map(([mark, text]) => (
                      <span key={text} className="proj-vis-point"><span aria-hidden="true" className={mark === '✓' ? 'is-yes' : undefined}>{mark}</span>{text}</span>
                    ))}
                  </label>
                );
              })}
            </fieldset>
          </section>
        </div>

        <aside className="proj-create-aside">
          <section className="proj-card is-compact" aria-labelledby="pc-room">
            <span id="pc-room" className="org-eyebrow">Sponsor’s room · {sponsor}</span>
            {room.length > 0 ? (
              <>
                <RoomBars rows={room} />
                <span className="org-muted">Striped = this project. Private projects count twice: once as a project, once as private.</span>
              </>
            ) : (
              <span className="org-muted">
                {sponsorIsMe
                  ? 'Your limits can’t be read right now. Creating checks them again.'
                  : `${sponsor}’s usage is visible only to them. The server checks their limits and answers 402 if there’s no room.`}
              </span>
            )}
          </section>

          <section className="proj-card is-compact" aria-labelledby="pc-summary">
            <span id="pc-summary" className="org-eyebrow">Summary</span>
            <strong className="proj-summary-name">{name.trim() || 'Untitled project'}</strong>
            <code className="proj-summary-path">/app/{orgSlug}/{slug}</code>
            <span><VisibilityChip visibility={visibility} /></span>
            {refusal && (
              <Notice tone="error">
                <span>{refusal.text}</span>
                {refusal.kind === 'quota' && (
                  <span className="org-notice-links">
                    {isPrivate && refusal.limitId === 'privateProjects' && (
                      <button type="button" className="org-link-button" onClick={() => { setVisibility('public'); setRefusal(null); }}>Make it public instead</button>
                    )}
                    <Link to="/app/account/usage">Usage</Link>
                  </span>
                )}
                {refusal.kind === 'pricing' && (
                  <span className="org-notice-links">
                    <button type="button" className="org-link-button" onClick={() => void create()}>Try again</button>
                  </span>
                )}
              </Notice>
            )}
            {creating && <div role="status" className="org-creating"><span className="org-spinner" aria-hidden="true" />Creating…</div>}
            <Action type="submit" variant="primary" disabled={!valid} busy={creating}>Create project</Action>
            <Link className="proj-cancel" to={`/app/${orgSlug}`} viewTransition>Cancel</Link>
          </section>
          <RoleLine role={organization.effective_role} />
        </aside>
      </form>
    </div>
  );
}

function RoleLine({ role }: { role: Parameters<typeof RoleChip>[0]['role'] }) {
  return <span className="org-muted proj-role-line">Your role here: <RoleChip role={role} /></span>;
}
