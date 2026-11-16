import { useId, useRef, useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import { platformApi } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { SLUG_PATTERN, slugFromName } from '../../shared/lib/slug';
import { atLeast, buildForest, flatten, pathOf } from './orgModel';
import { generalFailure } from '../../features/workspace/errors';
import { classifyAuthError, marker } from '../../shared/api/errors';
import { Choice, OrgTile, RoleChip } from './parts';
import './Organization.css';

interface Refusal {
  kind: 'slug' | 'parent' | 'other';
  text: string;
}

/** The words for each way the gateway can refuse the creation. */
function creationRefusal(caught: unknown, parentName: string | null): Refusal {
  const failure = classifyAuthError(caught);
  if (failure.status === 409) {
    return { kind: 'slug', text: 'That address is taken' + marker(failure) + '.' };
  }
  if (failure.status === 403) {
    return { kind: 'parent', text: parentName
      ? `You need ADMIN in ${parentName} to add an organization inside it${marker(failure)}. Ask one of its admins, or create it top-level.`
      : `You aren’t allowed to create this organization${marker(failure)}.` };
  }
  if (failure.status === 422) {
    return { kind: 'other', text: `The gateway refused these values${marker(failure)}. Check the name and the address.` };
  }
  if (failure.kind === 'not-found') {
    return { kind: 'parent', text: `The parent organization no longer exists${marker(failure)}. Choose another place for it.` };
  }
  return { kind: 'other', text: generalFailure(failure, 'nothing was created') };
}

interface OrgCreateProps {
  /** Cancel, the × button and Escape end here: the address goes back to the screen under the dialog. */
  onClose: () => void;
  /** The organization exists and the workspace knows it. The caller opens it. */
  onCreated: (organization: Organization) => void;
}

/** New organization: the dialog `New organization`, open at `/app?create=organization`. Name it and place it. */
export function OrgCreate({ onClose, onCreated }: OrgCreateProps) {
  const context = useOutletContext<PlatformOutletContext>();
  const slugId = useId();
  const slugHelpId = `${slugId}-help`;
  const slugInput = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [parentId, setParentId] = useState('');
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const organizations = context.organizations;
  const parent = organizations.find((item) => item.id === parentId);

  const slugValid = SLUG_PATTERN.test(slug);
  const slugTaken = organizations.some((item) => item.slug === slug);
  const nameValid = name.trim().length > 0;
  const valid = nameValid && slugValid && !slugTaken;

  // --- the tree preview
  const above = parent ? pathOf(parent, organizations) : [];
  const forest = flatten(buildForest(organizations));

  const typeName = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugFromName(value));
  };

  const create = async () => {
    setCreating(true);
    setRefusal(null);
    try {
      const organization = await platformApi.createOrganization({
        name: name.trim(),
        slug,
        parent_id: parentId || null,
      });
      await context.reload();
      onCreated(organization);
    } catch (caught) {
      setRefusal(creationRefusal(caught, parent?.name ?? null));
    } finally {
      setCreating(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (creating || !valid) return;
    void create();
  };

  const slugHelp = !slug
    ? 'Lowercase letters, numbers and hyphens. Can’t be changed later.'
    : !slugValid
      ? 'Use lowercase letters, numbers and hyphens; start and end with a letter or number (max 64).'
      : slugTaken ? 'Already used by another organization.' : 'Available to try · can’t be changed later.';
  const slugBad = Boolean(slug) && (!slugValid || slugTaken);

  return (
    <Modal title="New organization" size="lg" onClose={() => !creating && onClose()}>
      <form className="org-dialog" onSubmit={submit} noValidate>
        <p className="org-muted">Name it and place it.</p>

        <section className="org-dialog-section">
          <h3>Name and address</h3>
          <FormField
            label="Name"
            value={name}
            onChange={(event) => typeName(event.target.value)}
            maxLength={160}
            placeholder="e.g. Distributed Systems Lab"
            hint="Shown everywhere. You can change it later."
          />
          <div className="ui-field">
            <label htmlFor={slugId}>Address</label>
            <div className={`org-slug${slugBad ? ' is-invalid' : ''}`}>
              <span aria-hidden="true">/app/</span>
              <input
                id={slugId}
                ref={slugInput}
                value={slug}
                onChange={(event) => { setSlug(event.target.value); setSlugTouched(true); }}
                spellCheck={false}
                aria-invalid={slugBad || undefined}
                aria-describedby={slugHelpId}
              />
            </div>
            <span id={slugHelpId} className={`ui-field-note${slugBad ? ' is-error' : ''}`}>{slugHelp}</span>
          </div>
        </section>

        <section className="org-dialog-section">
          <h3>Where it sits</h3>
          <p className="org-muted">Place it inside an organization you administer, or keep it top-level. Everyone with a role above it gets the same role inside it.</p>
          <fieldset className="org-choices">
            <legend className="sr-only">Parent organization</legend>
            <Choice
              name="parent" value="" checked={parentId === ''} onChange={() => setParentId('')}
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
                  onChange={() => setParentId(item.id)}
                  label={item.name}
                  sub={allowed ? 'You can add organizations here' : `Needs ADMIN here; your role is ${item.effective_role}`}
                  warn={!allowed}
                  trailing={<RoleChip role={item.effective_role} />}
                />
              );
            })}
          </fieldset>
        </section>

        <section className="org-dialog-section">
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
        </section>

        {refusal?.kind === 'slug' && (
          <Notice tone="error">
            {refusal.text} Another organization already uses <code>/app/{slug}</code>.{' '}
            <button type="button" className="org-link-button" onClick={() => slugInput.current?.focus()}>Change the address</button>
          </Notice>
        )}
        {refusal && refusal.kind !== 'slug' && (
          <Notice tone={refusal.kind === 'other' ? 'error' : 'warning'}>{refusal.text}</Notice>
        )}

        {creating && <div role="status" className="org-creating"><span className="org-spinner" aria-hidden="true" />Creating {name.trim()}…</div>}

        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={creating}>Cancel</Action>
          <Action type="submit" variant="primary" busy={creating} disabled={!valid}>Create organization</Action>
        </div>
      </form>
    </Modal>
  );
}
