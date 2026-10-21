import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { libraryItemsApi, type LibraryItem, type LibraryVersion } from '../../api/libraryItems';
import type { ArtifactDraft } from '../../api/library';
import type { Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { templateFor } from './contentModel';
import { associateRefusal, createRefusal, draftRefusal, publishRefusal, withdrawRefusal, type PublishRefusal } from './libraryErrors';
import { DISPLAY_MAX, fixedName, KIND_CHOICES, NAME_PATTERN, OTHER_KIND } from './libraryModel';
import '../Project/Project.css';

function DialogError({ text }: { text?: string }) {
  return (
    <div aria-live="assertive">
      {text && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{text}</div>}
    </div>
  );
}

export interface CreatedItem {
  item: LibraryItem;
  /** The empty draft it starts with; `null` when that couldn't be made. */
  draft: ArtifactDraft | null;
  draftFailure?: string;
}

/** New library item: its kind, its fixed name and its display name; it starts with an empty draft shaped for its kind. */
export function NewItemDialog({ orgSlug, onClose, onCreated }: { orgSlug: string; onClose: () => void; onCreated: (created: CreatedItem) => void }) {
  const [choice, setChoice] = useState('CandidateCatalog');
  const [other, setOther] = useState('');
  const [name, setName] = useState('');
  const [display, setDisplay] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const kind = choice === OTHER_KIND ? other.trim() : choice;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name || !kind) {
      setError('Choose a kind and give it a fixed name.');
      return;
    }
    if (!NAME_PATTERN.test(name)) {
      setError('The fixed name starts with a letter or number and uses only letters, numbers, dots, hyphens and underscores.');
      return;
    }
    setBusy(true);
    setError(undefined);
    let item: LibraryItem;
    try {
      item = await libraryItemsApi.create(orgSlug, { name, display_name: display.trim() || name, kind });
    } catch (caught) {
      setError(createRefusal(caught, { kind, name }).text);
      setBusy(false);
      return;
    }
    try {
      const start = templateFor(kind, name);
      const draft = await libraryItemsApi.createDraft(item.id, { content: start.content as Record<string, unknown> | string, media_type: start.mediaType, contracts: [], dependencies: [] });
      onCreated({ item, draft });
    } catch (caught) {
      onCreated({ item, draft: null, draftFailure: draftRefusal(caught).text });
    }
  };

  return (
    <Modal title="New library item" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="ui-field">
          <label htmlFor="ni-kind">Kind</label>
          <select id="ni-kind" value={choice} onChange={(event) => { setChoice(event.target.value); setError(undefined); }}>
            {KIND_CHOICES.map((option) => <option key={option.id} value={option.id}>{option.label}{option.hint ? ` · ${option.hint}` : ''}</option>)}
            <option value={OTHER_KIND}>Other…</option>
          </select>
        </div>
        {choice === OTHER_KIND && <FormField label="Kind name" value={other} onChange={(event) => { setOther(event.target.value); setError(undefined); }} maxLength={128} spellCheck={false} />}
        <FormField
          label="Name (fixed)"
          value={name}
          onChange={(event) => { setName(fixedName(event.target.value)); setError(undefined); }}
          spellCheck={false}
          mono
          hint="Used in addresses and references; can’t be changed later."
        />
        <FormField label="Display name" value={display} maxLength={DISPLAY_MAX} onChange={(event) => { setDisplay(event.target.value); setError(undefined); }} hint="Shown in lists. You can rename it later." />
        <DialogError text={error} />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Create</Action>
        </div>
      </form>
    </Modal>
  );
}

/** Adds an item to a project of this organization: the project is picked from those the account can see. */
export function UseInProjectDialog({ orgSlug, item, projects, already, onClose, onAdded }: {
  orgSlug: string; item: LibraryItem; projects: Project[]; already: string[]; onClose: () => void; onAdded: (project: Project) => void;
}) {
  const choices = projects.filter((project) => !already.includes(project.slug));
  const [picked, setSlug] = useState('');
  // The projects that already have the item can arrive after the dialog opens, so the choice follows what is on offer.
  const slug = choices.some((project) => project.slug === picked) ? picked : choices[0]?.slug ?? '';
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const project = choices.find((candidate) => candidate.slug === slug);
    if (!project || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await libraryItemsApi.associate(orgSlug, project.slug, item.id);
      onAdded(project);
    } catch (caught) {
      setError(associateRefusal(caught, item.display_name).text);
      setBusy(false);
    }
  };

  return (
    <Modal title="Use in a project" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        {choices.length === 0
          ? <p>{projects.length === 0 ? 'This organization has no project yet.' : `“${item.display_name}” is already in every project of this organization.`}</p>
          : (
            <>
              <p>Adding “{item.display_name}” puts it one click away in the project. Nothing about the item or its versions changes.</p>
              <div className="ui-field">
                <label htmlFor="up-project">Project</label>
                <select id="up-project" value={slug} onChange={(event) => { setSlug(event.target.value); setError(undefined); }}>
                  {choices.map((project) => <option key={project.id} value={project.slug}>{project.name}</option>)}
                </select>
              </div>
            </>
          )}
        <DialogError text={error} />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy} disabled={choices.length === 0}>Add to project</Action>
        </div>
      </form>
    </Modal>
  );
}

/** Publishing a version: anyone will be able to read and cite it, under the title typed here. */
export function PublishDialog({ item, version, defaultTitle, onClose, onPublished, onRefused }: {
  item: LibraryItem; version: LibraryVersion; defaultTitle: string; onClose: () => void;
  onPublished: (version: LibraryVersion, title: string) => void; onRefused: (refusal: PublishRefusal) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const cited = title.trim() || defaultTitle;
    try {
      onPublished(await libraryItemsApi.publish(item.id, version.id, { title: cited }), cited);
    } catch (caught) {
      onRefused(publishRefusal(caught));
    }
  };

  return (
    <Modal title={`Publish version ${version.ref.version}`} size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <p>Anyone will be able to read it and cite it. You can withdraw it later, but references keep working.</p>
        <FormField label="Citation title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={DISPLAY_MAX} hint="How the version is named when someone cites it." />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Publish</Action>
        </div>
      </form>
    </Modal>
  );
}

/** Withdrawing is the one step that can't be taken back, so it asks first. */
export function WithdrawDialog({ item, version, onClose, onWithdrawn }: {
  item: LibraryItem; version: LibraryVersion; onClose: () => void; onWithdrawn: (version: LibraryVersion) => void;
}) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onWithdrawn(await libraryItemsApi.withdraw(item.id, version.id));
    } catch (caught) {
      setError(withdrawRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Withdraw version ${version.ref.version}?`} tone="danger" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <Notice tone="warning">
          It stops being listed, but anything that pins it keeps working. This can’t be undone: to publish again you’d seal a new version.
        </Notice>
        <DialogError text={error} />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="danger" busy={busy}>Withdraw</Action>
        </div>
      </form>
    </Modal>
  );
}

/** Sealing a draft: what gets frozen, and an optional label for the version. */
export function SealDialog({ freezes, error, busy, onClose, onSeal }: {
  freezes: string[]; error?: string; busy: boolean; onClose: () => void; onSeal: (label: string) => void;
}) {
  const [label, setLabel] = useState('');
  return (
    <Modal title="Seal a new version" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => { event.preventDefault(); if (!busy) onSeal(label.trim()); }} noValidate>
        <p>Sealing freezes:</p>
        <ul className="lib-freeze">{freezes.map((line) => <li key={line}>{line}</li>)}</ul>
        <FormField label="Version label (optional)" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={64} hint="Left empty, it takes the next number." />
        <DialogError text={error} />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Seal version</Action>
        </div>
      </form>
    </Modal>
  );
}
