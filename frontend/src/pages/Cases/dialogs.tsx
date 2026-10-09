import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { casesApi } from '../../api/cases';
import { platformApi } from '../../api/platform';
import type { BindingCase, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { createRefusal, deleteRefusal } from './caseErrors';
import { DESCRIPTION_MAX, NAME_MAX, plural, SLUG_PATTERN, slugFromName } from './casesModel';
import '../Project/Project.css';

export function NewCaseDialog({ organization, project, onClose, onCreated }: {
  organization: Organization; project: Project; onClose: () => void; onCreated: (created: BindingCase) => void;
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
      onCreated(await casesApi.createCase(organization.slug, project.slug, { slug, name: name.trim(), description: description.trim() }));
    } catch (caught) {
      setError(createRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal title="New case" size="md" onClose={() => !busy && onClose()}>
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
          <label htmlFor="nc-description">Description <span className="proj-optional">(optional)</span></label>
          <textarea id="nc-description" className="proj-textarea" rows={3} maxLength={DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>
        <div aria-live="assertive">
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="primary" busy={busy}>Create case</Action>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Deleting a case. The gateway refuses it (409) once the case holds a sealed revision, so the dialog says so up front
 * instead of letting a person type the address to be told no.
 */
export function DeleteCaseDialog({ organization, project, item, sealed, onClose, onDeleted }: {
  organization: Organization; project: Project; item: BindingCase; sealed: number; onClose: () => void; onDeleted: (name: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const matches = typed === item.slug;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches || busy || sealed > 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await platformApi.deleteCase(organization.slug, project.slug, item.slug);
      onDeleted(item.name);
    } catch (caught) {
      setError(deleteRefusal(caught).text);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Delete ${item.name}?`} tone="danger" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={(event) => void submit(event)} noValidate>
        {sealed > 0
          ? (
            <Notice tone="warning">
              This case has {plural(sealed, 'sealed revision')}, so it can’t be deleted (the gateway refuses it with a 409).
              Sealed history stays reachable so people can still verify anything that cites it.
            </Notice>
          )
          : <p>The case disappears from {project.name}. This can’t be undone.</p>}
        <FormField
          label={`Type ${item.slug} to confirm`}
          value={typed}
          onChange={(event) => { setTyped(event.target.value); setError(undefined); }}
          autoComplete="off"
          spellCheck={false}
          disabled={sealed > 0}
          mono
        />
        <div aria-live="assertive">
          {error && <div className="org-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="danger" disabled={!matches || sealed > 0} busy={busy}>Delete case</Action>
        </div>
      </form>
    </Modal>
  );
}
