import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Action } from '../../components/ui/Action';
import { Modal } from '../../components/ui/Modal';
import './EngineParts.css';

interface ConfirmProps {
  title: string;
  tone?: 'default' | 'danger' | 'warning';
  confirmLabel: string;
  confirmVariant?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** One question with a yes and a no, for a change that other people or later jobs would notice. */
export function ConfirmDialog({ title, tone = 'default', confirmLabel, confirmVariant = 'primary', busy = false, onConfirm, onClose, children }: ConfirmProps) {
  return (
    <Modal title={title} tone={tone} onClose={busy ? () => undefined : onClose} dismissible={!busy}>
      {children}
      <div className="ui-modal-actions">
        <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
        <Action variant={confirmVariant} busy={busy} onClick={onConfirm}>{confirmLabel}</Action>
      </div>
    </Modal>
  );
}

interface DeregisterProps {
  name: string;
  version: string;
  published: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Deleting a registration is not undone, so the registration’s name has to be typed. */
export function DeregisterDialog({ name, version, published, busy = false, onConfirm, onClose }: DeregisterProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed === name && !busy) onConfirm();
  };
  return (
    <Modal title={`Delete ${name} ${version}?`} tone="danger" onClose={busy ? () => undefined : onClose} dismissible={!busy}>
      <form className="eng-dialog-form" onSubmit={submit}>
        <p>Its stored credential goes with it, and you can no longer pick it for jobs. This can’t be undone.</p>
        {published && (
          <p className="eng-dialog-warning">
            It’s published, so other people may rely on it. Administrators are told when you delete a published registration.
          </p>
        )}
        <label htmlFor={inputId}>
          Type <strong className="is-mono">{name}</strong> to confirm
        </label>
        <input
          id={inputId}
          className="eng-dialog-input"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
          <Action type="submit" variant="danger" busy={busy} disabled={typed !== name}>Delete registration</Action>
        </div>
      </form>
    </Modal>
  );
}
