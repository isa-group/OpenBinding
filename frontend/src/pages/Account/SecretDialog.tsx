import { useId, useState, type ReactNode } from 'react';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { Modal } from '../../components/ui/Modal';

interface SecretDialogProps {
  title: string;
  /** What this secret replaces or is for, under the title. */
  children: ReactNode;
  /** The secret. It lives in this component's props only while the dialog is open and is not stored anywhere. */
  secret: string;
  /** Called once the person has said they stored it. */
  onDone: () => void;
  doneLabel?: string;
}

/**
 * The one time a new API-key secret is shown. It cannot be dismissed by accident: no ×, no Escape, no backdrop.
 * The way out is to confirm that the secret is stored, because the gateway keeps only its hash.
 */
export function SecretDialog({ title, children, secret, onDone, doneLabel = 'Done' }: SecretDialogProps) {
  const [stored, setStored] = useState(false);
  const checkbox = useId();
  return (
    <Modal title={title} tone="warning" size="lg" dismissible={false} onClose={() => undefined}>
      <div className="acct-secret-intro">{children}</div>
      <CopyField value={secret} label="secret" className="acct-secret" />
      <label htmlFor={checkbox} className="acct-check">
        <input id={checkbox} type="checkbox" checked={stored} onChange={(event) => setStored(event.target.checked)} />
        I’ve stored the secret somewhere safe
      </label>
      <Action variant="primary" disabled={!stored} onClick={onDone}>{doneLabel}</Action>
    </Modal>
  );
}
