import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { platformApi, type Collection, type CollectionRevision, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { Gate } from '../Organization/parts';
import { saveBytes } from '../Project/download';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import {
  differences, entriesOf, entryFromPin, move, newestFirst, sameList, type Difference, type Entry, type Pin,
} from './collectionModel';
import { ConfirmDialog, ItemPickerDialog } from './dialogs';
import { ResourceFrame } from './parts';
import { loadPins } from './resourceData';
import {
  classifyAuthError, collectionDeleteRefusal, collectionRenameRefusal, collectionSaveRefusal, isMissing, marker,
} from './resourceErrors';
import { DESCRIPTION_MAX, NAME_MAX, plural } from './resourceModel';

const DRAFT = 'draft';

const TYPE_TONE: Record<string, 'accent' | 'success' | 'warning' | 'plain'> = { case: 'accent', resource: 'success' };
const typeName = (kind: string) => (kind === 'case' ? 'Case' : kind === 'resource' ? 'Resource' : kind);

function Rename({ organization, project, collection, onSaved, onCancel }: {
  organization: Organization; project: Project; collection: Collection; onSaved: () => void; onCancel: () => void;
}) {
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('Give it a name.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.updateCollection(organization.slug, project.slug, collection.slug, { name: name.trim(), description: description.trim() });
      onSaved();
    } catch (caught) {
      setError(collectionRenameRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate aria-label="Rename the collection">
      <div className="ui-field">
        <label htmlFor="cd-name">Name</label>
        <input id="cd-name" value={name} maxLength={NAME_MAX} onChange={(event) => { setName(event.target.value); setError(undefined); }} data-autofocus />
      </div>
      <div className="ui-field">
        <label htmlFor="cd-description">Description <span className="proj-optional">(optional)</span></label>
        <textarea id="cd-description" className="proj-textarea" rows={2} maxLength={DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <div aria-live="assertive">{error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}</div>
      <div className="proj-actions">
        <Action type="submit" variant="primary" busy={busy}>Save</Action>
        <Action variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Action>
      </div>
    </form>
  );
}

function ItemRow({ entry, index, count, editable, fresh, onMove, onRemove, copyKey }: {
  entry: Entry; index: number; count: number; editable: boolean; fresh: boolean; onMove: (delta: -1 | 1) => void; onRemove: () => void; copyKey: string;
}) {
  const { copy, status } = useCopy();
  return (
    <li className={`res-item${fresh ? ' is-new' : ''}`}>
      <span className="res-position" aria-hidden="true">{index + 1}</span>
      <Chip tone={TYPE_TONE[entry.kind] ?? 'plain'}>{typeName(entry.kind)}</Chip>
      <span className="res-item-label">
        {entry.href ? <Link to={entry.href} viewTransition>{entry.label}</Link> : <span>{entry.label}</span>}
        <small>{entry.sub}{entry.pin === null && entry.kind === 'resource' ? ' · can’t be re-pinned here' : ''}</small>
      </span>
      <button type="button" className="res-fingerprint" title={entry.digest} onClick={() => void copy(entry.digest, copyKey)} aria-label={`Copy fingerprint of ${entry.label}`}>
        {status(copyKey) === 'copied' ? 'copied' : status(copyKey) === 'failed' ? 'copy failed' : shortDigest(entry.digest)}
      </button>
      {editable && (
        <span className="res-item-tools">
          <button type="button" className="res-icon-button" onClick={() => onMove(-1)} disabled={index === 0} aria-label={`Move ${entry.label} up`}>↑</button>
          <button type="button" className="res-icon-button" onClick={() => onMove(1)} disabled={index === count - 1} aria-label={`Move ${entry.label} down`}>↓</button>
          <button type="button" className="res-icon-button is-danger" onClick={onRemove} aria-label={`Remove ${entry.label}`}>Remove</button>
        </span>
      )}
    </li>
  );
}

function Changes({ rows }: { rows: readonly Difference[] }) {
  if (rows.length === 0) return <p className="org-muted">No differences.</p>;
  return (
    <ul aria-label="Differences">
      {rows.map((row) => (
        <li key={`${row.kind}:${row.label}`}>
          <Chip tone={row.kind === 'added' ? 'success' : row.kind === 'removed' ? 'warning' : 'plain'}>{row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Moved'}</Chip>
          <span>{row.label}{row.kind === 'moved' ? ` · position ${row.from} → ${row.to}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

interface ComparePanelProps {
  revisions: readonly CollectionRevision[];
  entriesFor: (revision: CollectionRevision) => Entry[];
  working: readonly Entry[];
  changed: boolean;
}

/** Two revisions side by side as a list of changes; the unsaved list is one of the choices while there is one. */
function ComparePanel({ revisions, entriesFor, working, changed }: ComparePanelProps) {
  const ordered = newestFirst(revisions);
  const latest = ordered[0];
  const defaults = changed
    ? { from: String(latest?.revision ?? ''), to: DRAFT }
    : { from: String(ordered[1]?.revision ?? ''), to: String(latest?.revision ?? '') };
  const [picked, setPicked] = useState<{ from?: string; to?: string }>({});
  const from = picked.from ?? defaults.from;
  const to = picked.to ?? defaults.to;
  const side = (value: string): Entry[] | null => {
    if (value === DRAFT) return [...working];
    const found = ordered.find((revision) => String(revision.revision) === value);
    return found ? entriesFor(found) : null;
  };
  const left = side(from);
  const right = side(to);
  const name = (value: string) => (value === DRAFT ? 'your unsaved list' : `revision ${value}`);
  const options = [
    ...ordered.map((revision) => <option key={revision.id} value={String(revision.revision)}>Revision {revision.revision}</option>),
    ...(changed ? [<option key={DRAFT} value={DRAFT}>Your unsaved list</option>] : []),
  ];
  const nothing = ordered.length < 2 && !changed;

  return (
    <section className="res-compare" aria-labelledby="cd-compare">
      <strong id="cd-compare">{nothing ? 'Only one revision so far' : changed && to === DRAFT && from === String(latest?.revision) ? `Your changes vs revision ${latest?.revision}` : `${name(to).replace(/^./, (c) => c.toUpperCase())} vs ${name(from)}`}</strong>
      {nothing && <p className="org-muted">Save a second revision to compare them.</p>}
      {!nothing && (
        <>
          <div className="res-compare-pickers">
            <div className="ui-field">
              <label htmlFor="cd-from">From</label>
              <select id="cd-from" value={from} onChange={(event) => setPicked({ ...picked, from: event.target.value })}>{options}</select>
            </div>
            <div className="ui-field">
              <label htmlFor="cd-to">To</label>
              <select id="cd-to" value={to} onChange={(event) => setPicked({ ...picked, to: event.target.value })}>{options}</select>
            </div>
          </div>
          {left && right ? <Changes rows={differences(left, right)} /> : <p className="org-muted">Pick two revisions to compare.</p>}
        </>
      )}
    </section>
  );
}

function Body({ organization, project, access, collectionSlug }: { organization: Organization; project: Project; access: ProjectAccess; collectionSlug: string }) {
  const slug = organization.slug;
  const root = `/app/${slug}/${project.slug}`;
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [toast, setToast] = useState('');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  /** The list being worked on; `null` while it is exactly the latest revision. */
  const [working, setWorking] = useState<Entry[] | null>(null);
  /** The sealed revision on show instead of the latest, read only. */
  const [viewing, setViewing] = useState<number | null>(null);
  const found = useResource(`collection:${slug}/${project.slug}/${collectionSlug}`, () => platformApi.collection(slug, project.slug, collectionSlug));
  const revisions = useResource(`collection-revisions:${slug}/${project.slug}/${collectionSlug}`, () => platformApi.collectionRevisions(slug, project.slug, collectionSlug));
  const pins = useResource<Pin[]>(`collection-pins:${slug}/${project.slug}`, () => loadPins(slug, project.slug, root));
  const collection = found.data ?? found.stale;
  const failure = found.status === 'error' ? classifyAuthError(found.error) : null;
  const trail = [{ label: 'Collections', to: `${root}/collections` }, { label: collection?.name ?? collectionSlug }];

  if (failure && !collection) {
    return (
      <ResourceFrame organization={organization} project={project} section="collections" trail={trail}>
        {isMissing(failure)
          ? (
            <Gate title="Collection not found" action={<Action to={`${root}/collections`} variant="primary">All collections</Action>}>
              No collection with this address in {project.name}{marker(failure)}.
            </Gate>
          )
          : (
            <Notice tone={failure.status === 403 ? 'warning' : 'error'} action={failure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={found.reload}>Retry</Action>}>
              {failure.status === 403 ? `This account or API key can’t read this collection${marker(failure)}.` : `The collection couldn’t be loaded${marker(failure)}.`}
            </Notice>
          )}
      </ResourceFrame>
    );
  }
  if (!collection) {
    return (
      <ResourceFrame organization={organization} project={project} section="collections" trail={trail}>
        <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading the collection…</span><Skeleton variant="panel" /></div>
      </ResourceFrame>
    );
  }

  const known = pins.data ?? pins.stale ?? [];
  const sealed = newestFirst(revisions.data ?? revisions.stale ?? []);
  const latest = sealed[0];
  const entriesFor = (revision: CollectionRevision | undefined) => entriesOf(revision, known);
  const latestEntries = entriesFor(latest);
  const shownRevision = viewing !== null && viewing !== latest?.revision ? sealed.find((revision) => revision.revision === viewing) : undefined;
  const items = shownRevision ? entriesFor(shownRevision) : working ?? latestEntries;
  const changed = working !== null && !sameList(working, latestEntries);
  const canEdit = access.canCreate && !shownRevision;
  const ready = revisions.status === 'ready' && pins.status !== 'loading';
  const nextNumber = (latest?.revision ?? 0) + 1;
  const revisionFailure = revisions.status === 'error' ? classifyAuthError(revisions.error) : null;
  const latestKeys = new Set(latestEntries.map((entry) => entry.key));

  const edit = (next: Entry[]) => { setWorking(next); setProblem(''); setToast(''); };

  const save = async () => {
    if (!changed || !working || saving) return;
    const blocked = working.filter((entry) => entry.pin === null);
    if (blocked.length > 0) {
      setProblem(`${plural(blocked.length, 'item')} here ${blocked.length === 1 ? 'was' : 'were'} pinned from the library and can’t be re-pinned from this page: ${blocked.map((entry) => entry.label).join(', ')}. Remove ${blocked.length === 1 ? 'it' : 'them'} to save, or edit this collection in the library.`);
      return;
    }
    setSaving(true);
    setProblem('');
    setToast('');
    try {
      const saved = await platformApi.createCollectionRevision(slug, project.slug, collection.slug, working.flatMap((entry) => (entry.pin ? [entry.pin] : [])));
      setWorking(null);
      setViewing(null);
      setToast(saved.revision > (latest?.revision ?? 0) ? `Revision ${saved.revision} saved and sealed.` : `That exact list is already revision ${saved.revision}; the latest revision is still ${latest?.revision}.`);
      revisions.reload();
    } catch (caught) {
      setProblem(collectionSaveRefusal(caught).text);
    } finally {
      setSaving(false);
    }
  };

  const exportManifest = () => {
    const target = shownRevision ?? latest;
    if (!target) return;
    const manifest = { kind: 'Collection', collection: collection.slug, name: collection.name, revision: target.revision, digest: target.digest, items: target.items, exported_at: new Date().toISOString() };
    saveBytes(new TextEncoder().encode(JSON.stringify(manifest, null, 2)).buffer as ArrayBuffer, `collection-${collection.slug}-r${target.revision}.json`, 'application/json');
  };

  return (
    <ResourceFrame organization={organization} project={project} section="collections" trail={trail}>
      <header className="proj-title-row">
        <div className="proj-title">
          {!renaming && (
            <span className="res-title-line">
              <h1>{collection.name}</h1>
              {access.canCreate && <Action variant="link" size="sm" onClick={() => { setRenaming(true); setToast(''); }}>Rename</Action>}
            </span>
          )}
          {renaming && (
            <Rename
              organization={organization}
              project={project}
              collection={collection}
              onCancel={() => setRenaming(false)}
              onSaved={() => { setRenaming(false); setToast('Name saved.'); found.reload(); }}
            />
          )}
          <p>
            {latest ? `Revision ${latest.revision} · ${plural(latest.items.length, 'item')}` : 'No revision yet'}
            {collection.description ? ` · ${collection.description}` : ''}
          </p>
          <span className="lib-meta"><code>{collection.slug}</code></span>
        </div>
        <div className="proj-actions">
          <Action to={`${root}/studies/new?collection=${encodeURIComponent(collection.slug)}`} variant="secondary">Start a study from this</Action>
          <Action variant="secondary" onClick={() => setComparing(!comparing)} aria-expanded={comparing}>{comparing ? 'Hide comparison' : 'Compare revisions'}</Action>
          {latest && <Action variant="secondary" onClick={exportManifest}>Export manifest</Action>}
          {access.canCreate && <Action variant="secondary" onClick={() => setPicking(true)} disabled={!canEdit || !ready}>Add item</Action>}
          {access.canCreate && <Action variant="primary" onClick={() => void save()} disabled={!changed || !canEdit} busy={saving}>Save as revision {nextNumber}</Action>}
          {access.canAdminister && <Action variant="danger-outline" onClick={() => setRemoving(true)}>Delete</Action>}
        </div>
      </header>

      {!access.canCreate && <ReadOnlyNote role={access.role}>You can read every revision and compare them; adding, reordering and saving need MEMBER.</ReadOnlyNote>}
      {toast && <div className="org-toast" role="status"><CheckCircle2 aria-hidden="true" /><span>{toast}</span></div>}
      {problem && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" /><span>{problem}</span></div>}
      {changed && <Notice tone="warning">Unsaved changes to the list. Saving creates a new sealed revision; the previous one stays as it was.</Notice>}
      {shownRevision && (
        <Notice
          tone="info"
          action={(
            <span className="proj-actions">
              <Action variant="secondary" size="sm" onClick={() => setViewing(null)}>Back to the latest</Action>
              {access.canCreate && <Action variant="secondary" size="sm" onClick={() => { edit(entriesFor(shownRevision)); setViewing(null); }}>Start from this revision</Action>}
            </span>
          )}
        >
          You’re reading revision {shownRevision.revision}, not the latest. It never changes.
        </Notice>
      )}

      {(revisions.status === 'loading' || pins.status === 'loading') && (
        <div role="status" aria-busy="true" className="case-skeletons"><span className="sr-only">Loading the items…</span><Skeleton variant="tile" /><Skeleton variant="tile" /></div>
      )}
      {revisionFailure && (
        <Notice tone={revisionFailure.status === 403 ? 'warning' : 'error'} action={revisionFailure.status === 403 ? undefined : <Action variant="secondary" size="sm" onClick={revisions.reload}>Retry</Action>}>
          {`The revisions couldn’t be loaded${marker(revisionFailure)}.`}
        </Notice>
      )}
      {ready && items.length === 0 && (
        <section className="lib-dashed lib-nothing" aria-labelledby="cd-empty">
          <strong id="cd-empty">No items yet</strong>
          <span>{access.canCreate ? 'Add cases or resources to make the first revision.' : 'A member can add cases or resources to make the first revision.'}</span>
        </section>
      )}
      {ready && items.length > 0 && (
        <ol className="res-items" aria-label="Items">
          {items.map((entry, index) => (
            <ItemRow
              key={entry.key}
              entry={entry}
              index={index}
              count={items.length}
              editable={canEdit}
              fresh={canEdit && changed && !latestKeys.has(entry.key)}
              copyKey={`item-${index}`}
              onMove={(delta) => edit(move(items, index, delta))}
              onRemove={() => edit(items.filter((_, position) => position !== index))}
            />
          ))}
        </ol>
      )}

      {comparing && ready && <ComparePanel revisions={sealed} entriesFor={entriesFor} working={items} changed={changed} />}

      {sealed.length > 0 && (
        <section className="res-revisions-block" aria-labelledby="cd-revisions">
          <p className="res-pick-group" id="cd-revisions">Revisions</p>
          <ul className="res-rev-chips">
            {sealed.map((revision, index) => (
              <li key={revision.id}>
                <button
                  type="button"
                  className="res-rev-chip"
                  aria-pressed={(shownRevision ? shownRevision.revision : latest?.revision) === revision.revision}
                  onClick={() => setViewing(index === 0 ? null : revision.revision)}
                >
                  Revision {revision.revision} · {plural(revision.items.length, 'item')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="lib-footnote">Each revision is sealed with a fingerprint over its exact list and order. {pins.status === 'error' && 'The project’s cases and resources couldn’t be read, so some items show only their fingerprint.'}</p>

      {picking && (
        <ItemPickerDialog
          pins={known}
          taken={new Set(items.map((entry) => entry.key))}
          loading={pins.status === 'loading'}
          problem={pins.status === 'error' ? `The project’s cases and resources couldn’t be read${marker(classifyAuthError(pins.error))}.` : undefined}
          onClose={() => setPicking(false)}
          onPick={(pin) => { edit([...items, entryFromPin(pin)]); setPicking(false); }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${collection.name}?`}
          confirmLabel="Delete collection"
          onClose={() => setRemoving(false)}
          run={() => platformApi.deleteCollection(slug, project.slug, collection.slug)}
          refusal={(caught) => collectionDeleteRefusal(caught).text}
          onDone={() => { setRemoving(false); void navigate(`${root}/collections`, { state: { toast: `${collection.name} deleted. The things it pointed to are untouched.` } }); }}
        >
          <p>The collection and its revisions leave {project.name}. The cases and resources it pinned are not touched.</p>
        </ConfirmDialog>
      )}
    </ResourceFrame>
  );
}

/** One collection (`coll-detail`, `/app/:org/:project/collections/:collection`): its ordered items, how to add and reorder them, its revisions and their comparison. */
export function CollDetail() {
  const { collection: collectionSlug = '' } = useParams();
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <Body key={collectionSlug} organization={organization} project={project} access={access} collectionSlug={collectionSlug} />;
}
