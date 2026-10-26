import { useState, type FormEvent, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { platformApi } from '../../api/platform';
import type { Collection, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { readZipArchive, type ZipFileEntry } from '../../utils/zipExplorer';
import { formatByteSize } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import type { Pin } from './collectionModel';
import { collectionCreateRefusal } from './resourceErrors';
import { DESCRIPTION_MAX, NAME_MAX, SLUG_PATTERN, slugFromName } from './resourceModel';
import '../Project/Project.css';

function DialogError({ text }: { text: string | undefined }) {
  return (
    <div aria-live="assertive">
      {text && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{text}</div>}
    </div>
  );
}

// --- collections

export function NewCollectionDialog({ organization, project, onClose, onCreated }: {
  organization: Organization; project: Project; onClose: () => void; onCreated: (created: Collection) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const slug = address ?? slugFromName(name);
  const slugOk = SLUG_PATTERN.test(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim() || !slugOk) {
      setError('Give it a name and a valid address: lowercase letters, numbers and hyphens.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await platformApi.createCollection(organization.slug, project.slug, { slug, name: name.trim(), description: description.trim() }));
    } catch (caught) {
      setError(collectionCreateRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal title="New collection" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <FormField label="Name" value={name} maxLength={NAME_MAX} onChange={(event) => { setName(event.target.value); setError(undefined); }} />
        <FormField
          label="Address"
          value={slug}
          onChange={(event) => { setAddress(event.target.value); setError(undefined); }}
          spellCheck={false}
          mono
          error={slug && !slugOk ? 'Lowercase letters, numbers and hyphens.' : undefined}
          hint="Used in the address; can’t be changed later."
        />
        <div className="ui-field">
          <label htmlFor="nc-collection-description">Description <span className="proj-optional">(optional)</span></label>
          <textarea id="nc-collection-description" className="proj-textarea" rows={2} maxLength={DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <DialogError text={error} />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Create</Action>
        </div>
      </form>
    </Modal>
  );
}

/** What can be added to a collection: the project’s case revisions and resource revisions that are not in the list yet. */
export function ItemPickerDialog({ pins, taken, loading, problem, onClose, onPick }: {
  pins: readonly Pin[]; taken: ReadonlySet<string>; loading: boolean; problem?: string; onClose: () => void; onPick: (pin: Pin) => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const available = pins.filter((pin) => !taken.has(pin.key) && (!needle || `${pin.label} ${pin.sub}`.toLowerCase().includes(needle)));
  const groups: Array<{ title: string; items: Pin[] }> = [
    { title: 'Cases', items: available.filter((pin) => pin.kind === 'case') },
    { title: 'Resources', items: available.filter((pin) => pin.kind === 'resource') },
  ];
  const everything = pins.filter((pin) => !taken.has(pin.key)).length;

  return (
    <Modal title="Add an item" size="lg" onClose={onClose}>
      <div className="org-dialog-form">
        <div className="ui-field res-pick-search">
          <label htmlFor="ai-search" className="sr-only">Search</label>
          <input id="ai-search" type="search" value={query} placeholder="Search cases and resources…" onChange={(event) => setQuery(event.target.value)} />
        </div>
        {loading && <p className="org-muted" role="status">Reading the project’s cases and resources…</p>}
        {problem && <p className="lib-error-text" role="alert">{problem}</p>}
        {!loading && !problem && everything === 0 && <p className="org-muted">Everything available is already in the list.</p>}
        {!loading && everything > 0 && available.length === 0 && <p className="org-muted">Nothing matches.</p>}
        {groups.filter((group) => group.items.length > 0).map((group) => (
          <div key={group.title}>
            <p className="res-pick-group">{group.title}</p>
            <ul className="res-picks" aria-label={group.title}>
              {group.items.map((pin) => (
                <li key={pin.key}>
                  <button type="button" className="lib-pick" onClick={() => onPick(pin)} aria-label={`Add ${pin.label}`}>
                    <span><strong>{pin.label}</strong><small>{pin.sub} · {pin.digest.length > 24 ? `${pin.digest.slice(0, 11)}…${pin.digest.slice(-4)}` : pin.digest}</small></span>
                    <span className="lib-pick-add">Add</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="lib-footnote">A collection pins exact revisions. Results and reports can’t be pinned here yet.</p>
        <div className="ui-modal-actions"><Action variant="secondary" onClick={onClose}>Close</Action></div>
      </div>
    </Modal>
  );
}

// --- the rest

interface ConfirmProps {
  title: string;
  confirmLabel: string;
  children: ReactNode;
  onClose: () => void;
  /** Runs the deletion; a rejection is turned into words by `refusal`. */
  run: () => Promise<void>;
  refusal: (caught: unknown) => string;
  onDone: () => void;
}

/** Asking before something goes: what happens and what doesn’t, then two buttons. */
export function ConfirmDialog({ title, confirmLabel, children, onClose, run, refusal, onDone }: ConfirmProps) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
      onDone();
    } catch (caught) {
      setError(refusal(caught));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} tone="danger" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)}>
        {children}
        <DialogError text={error} />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="danger" busy={busy}>{confirmLabel}</Action>
        </div>
      </form>
    </Modal>
  );
}

/** What is inside a ZIP the project holds: the names and sizes of its files, read in the browser. Nothing is opened for editing. */
export function ZipPeekDialog({ title, load, onClose }: { title: string; load: () => Promise<ArrayBuffer>; onClose: () => void }) {
  const archive = useResource<ZipFileEntry[]>(`zip-peek:${title}`, async () => (await readZipArchive(await load())).entries.filter((entry) => !entry.dir));
  const entries = archive.data ?? [];
  return (
    <Modal title={`Inside ${title}`} size="lg" onClose={onClose}>
      <div className="org-dialog-form">
        {archive.status === 'loading' && <p className="org-muted" role="status">Reading the archive…</p>}
        {archive.status === 'error' && <p className="lib-error-text" role="alert">This file couldn’t be read as a ZIP archive.</p>}
        {archive.status === 'ready' && entries.length === 0 && <p className="org-muted">The archive has no files.</p>}
        {entries.length > 0 && (
          <ul className="res-zip-list" aria-label="Files in the archive">
            {entries.map((entry) => <li key={entry.path}><code>{entry.path}</code><span>{formatByteSize(entry.size)}</span></li>)}
          </ul>
        )}
        <p className="lib-footnote">Files in an archive are described here, not opened. Download the archive to read them.</p>
        <div className="ui-modal-actions"><Action variant="secondary" onClick={onClose}>Close</Action></div>
      </div>
    </Modal>
  );
}
