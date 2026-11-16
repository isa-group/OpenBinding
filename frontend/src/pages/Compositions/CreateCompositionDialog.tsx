import { useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { compositionsApi } from '../../entities/composition/api';
import type { Kind } from '../../entities/composition/document';
import { KIND_OPTIONS } from '../../entities/composition/kinds';
import { SLUG_PATTERN, slugFromName } from '../../shared/lib/slug';
import { readApiError } from '../../shared/api/errors';
import type { CompositionView } from '../../shared/api/types';
import '../../features/workspace/kit.css';

const NAME_MAX = 160;
const DESCRIPTION_MAX = 2000;

/**
 * Start a composition of the organization (`?create=composition`): its address, name, kind and description. It starts with no
 * version; a taken address is said beside the address, and nothing is created.
 */
export function CreateCompositionDialog({
  organization,
  onClose,
  onCreated,
}: {
  organization: Organization;
  onClose: () => void;
  onCreated: (created: CompositionView) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('application');
  const [description, setDescription] = useState('');
  const [taken, setTaken] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const slug = address ?? slugFromName(name);
  const slugOk = slug === '' || SLUG_PATTERN.test(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setError('Give the composition a name.');
      return;
    }
    if (!slug || !slugOk) {
      setError('The address can only have lowercase letters, numbers and hyphens.');
      return;
    }
    setBusy(true);
    setError('');
    setTaken(false);
    try {
      onCreated(
        await compositionsApi.create(organization.slug, {
          slug,
          name: name.trim(),
          kind,
          description: description.trim(),
        })
      );
    } catch (caught) {
      const refusal = readApiError(caught);
      if (refusal.code === 'slug_conflict') setTaken(true);
      else
        setError(refusal.message || 'The composition couldn’t be created. Try again in a moment.');
      setBusy(false);
    }
  };

  const slugError = taken
    ? `${slug} is in use in ${organization.name}. Choose another address.`
    : !slugOk
      ? 'Lowercase letters, numbers and hyphens.'
      : undefined;

  return (
    <Modal title="New composition" size="md" onClose={() => !busy && onClose()}>
      <form className="org-dialog-form" onSubmit={event => void submit(event)} noValidate>
        <FormField
          label="Name"
          value={name}
          maxLength={NAME_MAX}
          onChange={event => {
            setName(event.target.value);
            setError('');
            setTaken(false);
          }}
        />
        <FormField
          label="Address"
          value={slug}
          onChange={event => {
            setAddress(event.target.value);
            setError('');
            setTaken(false);
          }}
          spellCheck={false}
          mono
          error={slugError}
          hint="Used in the address; can’t be changed later. Taken from the name unless you write one."
        />
        <div className="ui-field">
          <label htmlFor="cc-kind">Kind</label>
          <select
            id="cc-kind"
            className="cmp-select"
            value={kind}
            onChange={event => setKind(event.target.value as Kind)}
          >
            {KIND_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ui-field">
          <label htmlFor="cc-description">
            Description <span className="proj-optional">(optional)</span>
          </label>
          <textarea
            id="cc-description"
            className="proj-textarea"
            rows={3}
            maxLength={DESCRIPTION_MAX}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </div>
        <p className="org-muted">
          The composition starts with no version. Its first version is sealed from a
          Composition2Yaml document.
        </p>
        <div aria-live="assertive">
          {error && (
            <div className="org-dialog-error" role="alert">
              <TriangleAlert aria-hidden="true" />
              {error}
            </div>
          )}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="primary" busy={busy}>
            Create composition
          </Action>
        </div>
      </form>
    </Modal>
  );
}
