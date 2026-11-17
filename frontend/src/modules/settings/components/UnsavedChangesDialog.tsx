// Adapted from SPHERE frontend/src/modules/settings/components/UnsavedChangesDialog.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: drawn in OpenBinding's accessible Modal (focus trap, Escape, inert background) instead of SPHERE's motion overlay;
// "Stay here" takes the focus, so Enter never discards by accident.

import { useRef } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { Modal } from '../../core/components/modal';

interface Props {
  open: boolean;
  onDiscard: () => void;
  onCancel: () => void;
}

export default function UnsavedChangesDialog({ open, onDiscard, onCancel }: Props) {
  const stay = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  return (
    <Modal title="Unsaved changes" tone="warning" size="sm" onClose={onCancel} initialFocus={stay}>
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 ring-1 ring-amber-200/60">
          <FiAlertTriangle className="h-5 w-5 text-amber-700" aria-hidden="true" />
        </div>
        <p className="text-[13px] leading-relaxed text-tp-steel">
          You have unsaved modifications in this section. If you leave now, these changes will be
          permanently lost.
        </p>
      </div>
      <div className="mt-6 flex items-center justify-end gap-2.5">
        <button
          ref={stay}
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded-md border border-tp-hairline-strong bg-tp-canvas px-4 py-2 text-[13px] font-medium text-tp-ink transition-colors hover:bg-tp-surface"
        >
          Stay here
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="cursor-pointer rounded-md bg-tp-ink px-4 py-2 text-[13px] font-medium text-tp-on-dark transition-colors hover:bg-tp-charcoal"
        >
          Discard changes
        </button>
      </div>
    </Modal>
  );
}
