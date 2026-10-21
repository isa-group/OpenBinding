import { useId, useState, type FormEvent } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { Check } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { Organization } from '../../api/platform';
import { platformApi } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { atLeast, buildForest, flatten, pathOf, SLUG_PATTERN, slugFromName, sponsorName } from './orgModel';
import { classifyAuthError, generalFailure, marker, quotaOf } from './orgErrors';
import { Breadcrumb, Choice, OrgTile, RoleChip } from './parts';
import { RoomBars } from './room';
import { roomFromCatalog, roomFromUsage, type RoomRow } from './roomModel';
import './Organization.css';

const STEPS = ['Name', 'Place', 'Sponsor', 'Review'] as const;
const ROOM_FOR_CREATE = ['organizations', 'members', 'projects'] as const;

interface SponsorOption {
  key: string;
  userId: string;
  label: string;
  sub: string;
  /** The plan of the sponsor, when the account is allowed to know it. */
  plan?: string;
}

interface Refusal {
  kind: 'slug' | 'quota' | 'pricing' | 'parent' | 'sponsor' | 'other';
  text: string;
}

/** The words for each way the gateway can refuse the creation. */
function creationRefusal(caught: unknown, sponsor: { label: string; isYou: boolean }, parentName: string | null, limitText: string): Refusal {
  const failure = classifyAuthError(caught);
  const quota = quotaOf(caught);
  if (failure.status === 409) {
    return { kind: 'slug', text: 'That address is taken' + marker(failure) + '.' };
  }
  if (failure.status === 402) {
    return {
      kind: 'quota',
      text: `The sponsor has no organizations left${marker(failure)}. ${sponsor.isYou ? 'You already sponsor' : `${sponsor.label} already sponsors`} ${quota ? `${quota.used ?? quota.limit} of ${quota.limit} organizations` : limitText}.`,
    };
  }
  if (failure.status === 503 && failure.code === 'pricing_unavailable') {
    return { kind: 'pricing', text: `The sponsor’s limits can’t be checked right now${marker(failure)}, so nothing was created.` };
  }
  if (failure.status === 403) {
    return failure.code === 'invalid_sponsor'
      ? { kind: 'sponsor', text: `This sponsor isn’t allowed${marker(failure)}. You can sponsor it yourself or use the parent’s sponsor.` }
      : { kind: 'parent', text: parentName
        ? `You need ADMIN in ${parentName} to add an organization inside it${marker(failure)}. Ask one of its admins, or create it top-level.`
        : `You aren’t allowed to create this organization${marker(failure)}.` };
  }
  if (failure.status === 422) {
    return failure.code === 'invalid_sponsor'
      ? { kind: 'sponsor', text: `That account can’t sponsor an organization${marker(failure)}. Choose another sponsor.` }
      : { kind: 'other', text: `The gateway refused these values${marker(failure)}. Check the name and the address.` };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'parent', text: `The parent organization no longer exists${marker(failure)}. Choose another place for it.` };
  }
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

/** New organization (`org-create`, `/app/organizations/new`): name it, place it, choose who sponsors it, review. */
export function OrgCreate() {
  const context = useOutletContext<PlatformOutletContext>();
  const { user, isAdmin } = useAuth();
  const slugId = useId();
  const slugHelpId = `${slugId}-help`;

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [parentId, setParentId] = useState('');
  const [sponsorKey, setSponsorKey] = useState('self');
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [created, setCreated] = useState<Organization | null>(null);

  const usage = useResource('create-usage', () => apiClient.getOwnUsage().catch(() => null));
  const catalog = useResource('create-catalog', () => (isAdmin ? apiClient.getPricingCatalog().catch(() => null) : Promise.resolve(null)));
  const accounts = useResource(`create-accounts:${isAdmin}`, () => (isAdmin ? apiClient.adminListUsers({ limit: 100 }).catch(() => null) : Promise.resolve(null)));
  const parentPeople = useResource(`create-parent-people:${parentId}`, () => {
    const parent = context.organizations.find((item) => item.id === parentId);
    return parent ? platformApi.members(parent.slug).catch(() => null) : Promise.resolve(null);
  });

  const organizations = context.organizations;
  const parent = organizations.find((item) => item.id === parentId);
  const me = user ? { id: user.id, username: user.username } : null;

  const slugValid = SLUG_PATTERN.test(slug);
  const slugTaken = organizations.some((item) => item.slug === slug);
  const nameValid = name.trim().length > 0;
  const step1Valid = nameValid && slugValid && !slugTaken;

  // --- sponsor choices
  const options: SponsorOption[] = [];
  if (me && user) options.push({ key: 'self', userId: me.id, label: `You (${me.username})`, sub: `Counts against your ${user.plan} plan`, plan: user.plan });
  if (parent && parent.billing_sponsor_user_id !== me?.id) {
    options.push({
      key: 'parent',
      userId: parent.billing_sponsor_user_id,
      label: `${sponsorName(parent, parentPeople.data ?? [], me)} · sponsor of ${parent.name}`,
      sub: 'Keeps the whole tree on one sponsor',
    });
  }
  for (const account of accounts.data?.users ?? []) {
    if (options.some((option) => option.userId === account.id)) continue;
    options.push({ key: `user:${account.id}`, userId: account.id, label: `${account.username} (${account.email})`, sub: `Administrator choice · their ${account.plan} plan`, plan: account.plan });
  }
  const sponsor = options.find((option) => option.key === sponsorKey) ?? options[0];
  const sponsorLabel = sponsor?.key === 'self' ? `you (${me?.username ?? ''})` : sponsor?.label.replace(/ \(.*\)$| · sponsor of .*$/, '') ?? 'the sponsor';

  // --- what the new organization adds to the sponsor's room
  const alreadyMember = sponsor ? organizations.some((item) => item.billing_sponsor_user_id === sponsor.userId) : false;
  const added = { organizations: 1, members: alreadyMember ? 0 : 1, projects: 0 };
  let room: RoomRow[] = [];
  if (sponsor?.key === 'self' && usage.data) room = roomFromUsage(usage.data, ROOM_FOR_CREATE, added);
  else if (sponsor?.plan && catalog.data) room = roomFromCatalog(catalog.data, sponsor.plan, ROOM_FOR_CREATE, added);
  const organizationsRow = room.find((item) => item.id === 'organizations');
  const limitText = organizationsRow?.limit != null ? `${organizationsRow.limit} organizations, the most its plan allows` : 'its organization limit';

  // --- the tree preview
  const above = parent ? pathOf(parent, organizations) : [];
  const forest = flatten(buildForest(organizations));

  const typeName = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugFromName(value));
  };

  const create = async () => {
    if (!sponsor) return;
    setCreating(true);
    setRefusal(null);
    try {
      const organization = await platformApi.createOrganization({
        name: name.trim(),
        slug,
        parent_id: parentId || null,
        billing_sponsor_user_id: sponsor.userId,
      });
      await context.reload();
      setCreated(organization);
    } catch (caught) {
      setRefusal(creationRefusal(caught, { label: sponsorLabel, isYou: sponsor.key === 'self' }, parent?.name ?? null, limitText));
      setStep(4);
    } finally {
      setCreating(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;
    if (step < 4) {
      if (step === 1 && !step1Valid) return;
      setStep(step + 1);
    } else {
      void create();
    }
  };

  const goTo = (target: number) => {
    if (target > 1 && !step1Valid) return;
    setRefusal(null);
    setStep(target);
  };

  const slugHelp = !slug
    ? 'Lowercase letters, numbers and hyphens. Can’t be changed later.'
    : !slugValid
      ? 'Use lowercase letters, numbers and hyphens; start and end with a letter or number (max 64).'
      : slugTaken ? 'Already used by another organization.' : 'Available to try · can’t be changed later.';
  const slugBad = Boolean(slug) && (!slugValid || slugTaken);

  if (created) {
    return (
      <div className="org-page is-sm">
        <Breadcrumb items={[{ label: 'Home', to: '/app' }, { label: 'New organization' }]} />
        <section className="org-done" role="status" aria-live="polite">
          <span className="org-done-mark" aria-hidden="true"><Check /></span>
          <div className="org-done-body">
            <strong>{created.name} is ready</strong>
            <span>
              You’re its <b>OWNER</b>. {parent ? `It sits inside ${parent.name}, so members there keep their roles here. ` : ''}
              Sponsored by {sponsorLabel}.
            </span>
          </div>
          <div className="org-done-actions">
            <Action to={`/app/${created.slug}`} variant="primary">Open organization</Action>
            <Action to={`/app/${created.slug}/new-project`} variant="secondary">Create the first project</Action>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="org-page is-sm">
      <Breadcrumb items={[{ label: 'Home', to: '/app' }, { label: 'New organization' }]} />
      <header className="org-head">
        <div>
          <h1>New organization</h1>
          <p>Three short steps: name it, place it, and choose who sponsors it.</p>
        </div>
      </header>

      <ol className="org-steps" aria-label="Steps">
        {STEPS.map((label, index) => {
          const n = index + 1;
          const done = step > n;
          const sub = [name.trim() || 'Not set', parent ? `Inside ${parent.name}` : 'Top-level', sponsor?.key === 'self' ? 'You' : sponsorLabel, 'Confirm and create'][index];
          return (
            <li key={label}>
              <button
                type="button"
                className={`org-step${step === n ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                aria-current={step === n ? 'step' : undefined}
                disabled={n > 1 && !step1Valid}
                onClick={() => goTo(n)}
              >
                <span className="org-step-mark">{done ? '✓' : n}</span>
                <span className="org-step-text"><strong>{label}</strong><small>{sub}</small></span>
              </button>
            </li>
          );
        })}
      </ol>

      <form className="org-wizard" onSubmit={submit} noValidate>
        <section className="org-wizard-main" aria-live="polite">
          {step === 1 && (
            <>
              <h2>Name and address</h2>
              <FormField
                label="Name"
                value={name}
                onChange={(event) => typeName(event.target.value)}
                maxLength={160}
                placeholder="e.g. Distributed Systems Lab"
                hint="Shown everywhere. You can change it later."
                maxWidth="460px"
              />
              <div className="ui-field org-slug-field">
                <label htmlFor={slugId}>Address</label>
                <div className={`org-slug${slugBad ? ' is-invalid' : ''}`}>
                  <span aria-hidden="true">/app/</span>
                  <input
                    id={slugId}
                    value={slug}
                    onChange={(event) => { setSlug(event.target.value); setSlugTouched(true); }}
                    spellCheck={false}
                    aria-invalid={slugBad || undefined}
                    aria-describedby={slugHelpId}
                  />
                </div>
                <span id={slugHelpId} className={`ui-field-note${slugBad ? ' is-error' : ''}`}>{slugHelp}</span>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2>Where it sits</h2>
              <p className="org-muted">Place it inside an organization you administer, or keep it top-level. Everyone with a role above it gets the same role inside it.</p>
              <fieldset className="org-choices">
                <legend className="sr-only">Parent organization</legend>
                <Choice
                  name="parent" value="" checked={parentId === ''} onChange={() => { setParentId(''); setSponsorKey('self'); }}
                  label="None · top-level organization" sub="Its own tree. Only you start with a role."
                />
                {forest.map(({ organization: item }) => {
                  const allowed = atLeast(item.effective_role, 'ADMIN');
                  return (
                    <Choice
                      key={item.id}
                      name="parent"
                      value={item.id}
                      checked={parentId === item.id}
                      disabled={!allowed}
                      onChange={() => { setParentId(item.id); setSponsorKey('self'); }}
                      label={item.name}
                      sub={allowed ? 'You can add organizations here' : `Needs ADMIN here; your role is ${item.effective_role}`}
                      warn={!allowed}
                      trailing={<RoleChip role={item.effective_role} />}
                    />
                  );
                })}
              </fieldset>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Who sponsors it</h2>
              <p className="org-muted">
                The sponsor’s plan pays for the organization’s size: organizations, members, projects and storage count against their limits.
                Sponsoring gives no role and no access.
              </p>
              <fieldset className="org-choices">
                <legend className="sr-only">Sponsor</legend>
                {options.map((option) => (
                  <Choice
                    key={option.key} name="sponsor" value={option.key} checked={sponsor?.key === option.key}
                    onChange={setSponsorKey} label={option.label} sub={option.sub}
                  />
                ))}
              </fieldset>
              {isAdmin && <span className="org-muted">As a platform administrator you may choose any account as sponsor.</span>}
            </>
          )}

          {step === 4 && (
            <>
              <h2>Review</h2>
              <dl className="org-review">
                <dt>Name</dt><dd><strong>{name.trim()}</strong></dd>
                <dt>Address</dt><dd><code>/app/{slug}</code></dd>
                <dt>Inside</dt><dd>{parent ? parent.name : 'Nothing (top-level)'}</dd>
                <dt>Sponsor</dt><dd>{sponsor?.key === 'self' ? `you (${me?.username})` : sponsorLabel}</dd>
                <dt>Your role</dt><dd><RoleChip role="OWNER" /></dd>
              </dl>
              {refusal?.kind === 'slug' && (
                <Notice tone="error">
                  {refusal.text} Another organization already uses <code>/app/{slug}</code>.{' '}
                  <button type="button" className="org-link-button" onClick={() => goTo(1)}>Change the address</button>
                </Notice>
              )}
              {refusal?.kind === 'quota' && (
                <Notice tone="error">
                  <span>{refusal.text}</span>
                  <span className="org-notice-links">
                    <Link to="/app/account/usage">See your plan</Link>
                    <button type="button" className="org-link-button" onClick={() => goTo(3)}>Choose another sponsor</button>
                    <Link to="/pricing">Compare plans</Link>
                  </span>
                </Notice>
              )}
              {refusal?.kind === 'pricing' && (
                <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={() => void create()} busy={creating}>Try again</Action>}>
                  {refusal.text}
                </Notice>
              )}
              {refusal && ['parent', 'sponsor', 'other'].includes(refusal.kind) && (
                <Notice tone={refusal.kind === 'other' ? 'error' : 'warning'}>{refusal.text}</Notice>
              )}
            </>
          )}

          {creating && <div role="status" className="org-creating"><span className="org-spinner" aria-hidden="true" />Creating {name.trim()}…</div>}

          <div className="org-wizard-actions">
            <span>
              <Action to="/app" variant="ghost">Cancel</Action>
              {step > 1 && <Action variant="secondary" onClick={() => goTo(step - 1)}>Back</Action>}
            </span>
            {step < 4
              ? <Action type="submit" variant="primary" disabled={step === 1 && !step1Valid}>Continue</Action>
              : <Action type="submit" variant="primary" busy={creating} disabled={!sponsor}>Create organization</Action>}
          </div>
        </section>

        <aside className="org-wizard-aside">
          <div className="org-card">
            <span className="org-eyebrow">Preview</span>
            <ul aria-label="Organization tree preview" className="org-preview">
              {above.map((item, depth) => (
                <li key={item.id} style={{ paddingLeft: depth * 20 }}>
                  <span className="org-preview-node"><OrgTile organization={item} size="xs" /><span>{item.name}</span></span>
                </li>
              ))}
              <li style={{ paddingLeft: above.length * 20 }}>
                <span className="org-preview-node is-new">
                  <OrgTile organization={{ name: name.trim() || 'New organization', slug: slug || 'new' }} size="xs" />
                  <span>{name.trim() || 'New organization'}</span>
                  <b>NEW</b>
                </span>
              </li>
            </ul>
            <span className="org-muted">
              {parent ? `Everyone with a role in ${parent.name} gets at least the same role in the new organization.` : 'A top-level organization starts with only you, as OWNER.'}
            </span>
          </div>
          <div className="org-card">
            <span className="org-eyebrow">Sponsor’s room after creating</span>
            {room.length > 0 ? <RoomBars rows={room} /> : (
              <span className="org-muted">
                {sponsor?.key === 'self' && usage.status === 'ready'
                  ? 'Your limits can’t be read right now. Creating checks them again.'
                  : 'This sponsor’s plan is visible only to them. The server checks their limits and answers 402 if there’s no room.'}
              </span>
            )}
            {room.length > 0 && (
              <span className="org-muted">
                {sponsor?.key === 'self' ? 'Counts come from your usage.' : 'Plan ceilings only; this account’s usage isn’t visible to you.'} Striped = what this organization adds.
              </span>
            )}
          </div>
        </aside>
      </form>
    </div>
  );
}
