// The two questions the engine screens ask before a change others would notice: a plain confirmation, and deleting a
// registration, which is not undone, so its name has to be typed. Both are OpenBinding's accessible modal.

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Action } from '../../../core/components/action-button';
import { Modal } from '../../../core/components/modal';

/** The row of buttons at the foot of a dialog: Cancel first, the answer last. */
const ACTIONS = 'mt-4 flex flex-wrap justify-end gap-2';

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
export function ConfirmDialog({
  title,
  tone = 'default',
  confirmLabel,
  confirmVariant = 'primary',
  busy = false,
  onConfirm,
  onClose,
  children,
}: ConfirmProps) {
  return (
    <Modal title={title} tone={tone} onClose={busy ? () => undefined : onClose} dismissible={!busy}>
      {children}
      <div className={ACTIONS}>
        <Action variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Action>
        <Action variant={confirmVariant} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Action>
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
export function DeregisterDialog({
  name,
  version,
  published,
  busy = false,
  onConfirm,
  onClose,
}: DeregisterProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed === name && !busy) onConfirm();
  };
  return (
    <Modal
      title={`Delete ${name} ${version}?`}
      tone="danger"
      onClose={busy ? () => undefined : onClose}
      dismissible={!busy}
    >
      <form className="flex flex-col gap-3 text-sm text-tp-slate" onSubmit={submit}>
        <p>
          Its stored credential goes with it, and you can no longer pick it for runs. This can’t be
          undone.
        </p>
        {published && (
          <p className="rounded-lg border border-tp-severity-warning-border bg-tp-severity-warning-bg px-3 py-2 text-tp-warning-text">
            It’s published, so other people may rely on it. Administrators are told when you delete
            a published registration.
          </p>
        )}
        <label htmlFor={inputId} className="text-xs font-medium text-tp-steel">
          Type <strong className="font-mono text-tp-ink">{name}</strong> to confirm
        </label>
        <input
          id={inputId}
          className="h-9 w-full rounded-md border border-tp-input-border bg-tp-input-bg px-2.5 font-mono text-sm text-tp-ink focus:border-tp-primary focus:outline-none"
          value={typed}
          onChange={event => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={ACTIONS}>
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="danger" busy={busy} disabled={typed !== name}>
            Delete registration
          </Action>
        </div>
      </form>
    </Modal>
  );
}
