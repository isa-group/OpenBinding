// Pattern only, after SPHERE frontend/src/modules/core/components/confirm-modal/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's modal recipe (an ink backdrop, a rounded-xl canvas panel with shadow-elevation-4 and a coloured top edge);
// OpenBinding's focus trap (hooks/useFocusTrap), Escape and inert background are kept.

import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MdClose } from 'react-icons/md';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface ModalProps {
  /** The dialog's accessible name and visible heading. */
  title: string;
  children: ReactNode;
  /** Asked to close by Escape, the backdrop and the × button. Never called when `dismissible` is false. */
  onClose: () => void;
  /** The coloured top edge: `danger` for destructive confirmations, `warning` for a secret shown once. */
  tone?: 'default' | 'danger' | 'warning';
  /** `false` for a step that must be completed on purpose (the one-time secret): no ×, Escape or backdrop close. */
  dismissible?: boolean;
  /** `sm` 400px, `md` 480px, `lg` 520px. */
  size?: 'sm' | 'md' | 'lg';
  /** A small label above the heading (“Warning”). */
  eyebrow?: ReactNode;
  /** The element that gets focus first. Otherwise `[data-autofocus]`, the first field, or the dialog itself. */
  initialFocus?: RefObject<HTMLElement | null>;
}

const TONES = {
  default: 'border-t-tp-primary',
  danger: 'border-t-tp-severity-error',
  warning: 'border-t-tp-severity-warning',
} as const;

const SIZES = { sm: 'max-w-[400px]', md: 'max-w-[480px]', lg: 'max-w-[520px]' } as const;

/**
 * A modal dialog: it takes focus, keeps Tab inside, closes on Escape and returns focus to what opened it.
 * The application behind it is inert while it is open.
 */
export function Modal({
  title,
  children,
  onClose,
  tone = 'default',
  dismissible = true,
  size = 'md',
  eyebrow,
  initialFocus,
}: ModalProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onKeyDown = useFocusTrap(panel, {
    onEscape: dismissible ? onClose : undefined,
    initialFocus,
    fallbackSelector: '.ui-modal-body input, .ui-modal-body select, .ui-modal-body textarea',
  });

  return createPortal(
    <div
      className="ui-modal-layer fixed inset-0 z-60 flex items-center justify-center p-4"
      onKeyDown={onKeyDown}
    >
      <div
        className="ui-modal-backdrop absolute inset-0 bg-tp-ink/60 backdrop-blur-[2px]"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panel}
        className={`ui-modal is-${tone} is-${size} relative flex max-h-[calc(100dvh-2rem)] w-full animate-fade-in flex-col overflow-hidden rounded-xl border border-t-4 border-tp-hairline bg-tp-canvas shadow-elevation-4 focus:outline-none ${TONES[tone]} ${SIZES[size]}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="ui-modal-head flex items-start justify-between gap-4 px-6 pt-5 pb-3">
          <div className="flex flex-col gap-1">
            {eyebrow && (
              <span className="ui-modal-eyebrow text-xs font-semibold tracking-wide text-tp-error-strong uppercase">
                {eyebrow}
              </span>
            )}
            <h2 id={titleId} className="text-lg leading-snug font-semibold text-tp-ink">
              {title}
            </h2>
          </div>
          {dismissible && (
            <button
              type="button"
              className="ui-modal-close flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
              onClick={onClose}
              aria-label="Close"
            >
              <MdClose className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </header>
        <div className="ui-modal-body overflow-y-auto px-6 pb-6 text-sm text-tp-slate">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
