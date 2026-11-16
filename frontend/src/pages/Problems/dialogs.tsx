import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { problemsApi, type Problem, type ProblemUpload } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { deleteRefusal, uploadRefusal, type Refusal } from './problemErrors';
import { DESCRIPTION_MAX, NAME_MAX } from './problemsModel';
import { SLUG_PATTERN, slugFromName } from '../../shared/lib/slug';
import '../../features/workspace/kit.css';

/** A package file a person picked: `.bim.zip` (or `.zip`). */
const PACKAGE_ACCEPT = '.zip,application/zip,application/vnd.bim+zip';

/** The name a file suggests for a problem: `simple-seq.bim.zip` → `simple-seq`. */
const nameOfFile = (file: File): string => file.name.replace(/\.bim\.zip$|\.zip$/i, '');

function RefusalText({ refusal }: { refusal: Refusal }) {
  return (
    <div className="org-dialog-error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <span>
        {refusal.text}
        {refusal.diagnostics && refusal.diagnostics.length > 0 && (
          <ul className="case-diagnostics" aria-label="What the compiler found">
            {refusal.diagnostics.slice(0, 8).map((item, index) => (
              <li key={`${item.code}-${index}`}>
                {item.resource && <code>{item.resource}</code>}{item.pointer && <code>{item.pointer}</code>} {item.message}
              </li>
            ))}
          </ul>
        )}
      </span>
    </div>
  );
}

function PackagePicker({ file, onPick, disabled }: { file: File | null; onPick: (file: File | null) => void; disabled?: boolean }) {
  return (
    <div className="ui-field">
      <label htmlFor="up-package">BIM package</label>
      <input id="up-package" type="file" accept={PACKAGE_ACCEPT} disabled={disabled} onChange={(event) => onPick(event.target.files?.[0] ?? null)} />
      <small className="ui-field-hint">{file ? `${file.name} · ${file.size.toLocaleString('en-US')} bytes` : 'A .bim.zip with instance.json at its root.'}</small>
    </div>
  );
}

/**
 * Upload a BIM package as a new problem of the organization (`?create=problem`). The package is compiled once: a refusal lists where it
 * is wrong, a taken address and a full plan say so, and nothing is created.
 */
export function UploadProblemDialog({ organization, onClose, onCreated }: {
  organization: Organization; onClose: () => void; onCreated: (created: ProblemUpload) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const shownName = name || (file ? nameOfFile(file) : '');
  const slug = address ?? slugFromName(shownName);
  const slugOk = slug === '' || SLUG_PATTERN.test(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!file) {
      setRefusal({ kind: 'invalid', text: 'Choose the .bim.zip package to upload.' });
      return;
    }
    if (!slugOk) {
      setRefusal({ kind: 'invalid', text: 'The address can only have lowercase letters, numbers and hyphens.' });
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      onCreated(await problemsApi.create(organization.slug, file, {
        slug: slug || undefined, name: shownName.trim() || undefined, description: description.trim() || undefined,
      }));
    } catch (caught) {
      setRefusal(uploadRefusal(caught, 'problem'));
      setBusy(false);
    }
  };

  return (
    <Modal title="Upload a BIM package" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <PackagePicker file={file} disabled={busy} onPick={(picked) => { setFile(picked); setRefusal(null); }} />
        <FormField label="Name" value={shownName} maxLength={NAME_MAX} hint="Taken from the file name unless you write one." onChange={(event) => { setName(event.target.value); setRefusal(null); }} />
        <FormField
          label="Address"
          value={slug}
          onChange={(event) => { setAddress(event.target.value); setRefusal(null); }}
          spellCheck={false}
          mono
          error={!slugOk ? 'Lowercase letters, numbers and hyphens.' : undefined}
          hint="Used in the address; can’t be changed later. Left empty, the package’s name is used."
        />
        <div className="ui-field">
          <label htmlFor="nc-description">Description <span className="proj-optional">(optional)</span></label>
          <textarea id="nc-description" className="proj-textarea" rows={3} maxLength={DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div aria-live="assertive">{refusal && <RefusalText refusal={refusal} />}</div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Upload problem</Action>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Upload a package as a new version of a problem. The same package again is not a new version: the gateway answers with the version it
 * already is (`created: false`), and the dialog's caller says so.
 */
export function UploadVersionDialog({ organization, item, onClose, onSaved }: {
  organization: Organization; item: Problem; onClose: () => void; onSaved: (saved: ProblemUpload) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!file) {
      setRefusal({ kind: 'invalid', text: 'Choose the .bim.zip package to upload.' });
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      onSaved(await problemsApi.createRevision(organization.slug, item.slug, file));
    } catch (caught) {
      setRefusal(uploadRefusal(caught, 'version'));
      setBusy(false);
    }
  };

  return (
    <Modal title={`New version of ${item.name}`} size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <PackagePicker file={file} disabled={busy} onPick={(picked) => { setFile(picked); setRefusal(null); }} />
        <p className="org-muted">The package is sealed as the next version. Uploading a package that already is a version of this problem changes nothing.</p>
        <div aria-live="assertive">{refusal && <RefusalText refusal={refusal} />}</div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Upload version</Action>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Deleting a problem takes its versions with it. The gateway refuses it (409 `problem_has_runs`) while a run or a study names one of
 * them: those stay as evidence.
 */
export function DeleteCaseDialog({ organization, item, onClose, onDeleted }: {
  organization: Organization; item: Problem; onClose: () => void; onDeleted: (name: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const matches = typed === item.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await problemsApi.remove(organization.slug, item.slug);
      onDeleted(item.name);
    } catch (caught) {
      setError(deleteRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${item.name}?`} tone="danger" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        <p>The problem and its versions disappear from {organization.name}. This can’t be undone. A problem that runs or studies used can’t be deleted.</p>
        <FormField
          label={`Type ${item.slug} to confirm`}
          value={typed}
          onChange={(event) => { setTyped(event.target.value); setError(undefined); }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <div aria-live="assertive">
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="danger" disabled={!matches} busy={busy}>Delete problem</Action>
        </div>
      </form>
    </Modal>
  );
}
