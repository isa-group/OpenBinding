import type { ReactNode } from 'react';
import { Action, type ActionVariant } from '../../../core/components/action-button';
import { Modal } from '../../../core/components/modal';
import { DIALOG_ACTIONS } from '../admin-parts';

interface ConfirmDialogProps {
  title: string;
  /** `danger` for a change that can't be taken back, `warning` for one that can. */
  tone?: 'default' | 'danger' | 'warning';
  confirmLabel: string;
  confirmVariant?: ActionVariant;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

/**
 * An administrator's confirmation of one change, on the core modal (its focus trap, Escape and inert background): what the change
 * does, Cancel and the confirmation. While the change is sent the dialog stays open and can't be dismissed.
 */
export default function ConfirmDialog({
  title,
  tone = 'default',
  confirmLabel,
  confirmVariant = 'primary',
  busy = false,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal title={title} tone={tone} onClose={busy ? () => undefined : onClose} dismissible={!busy}>
      <div className="flex flex-col gap-2">{children}</div>
      <div className={DIALOG_ACTIONS}>
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
