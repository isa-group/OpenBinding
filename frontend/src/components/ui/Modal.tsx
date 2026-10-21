import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './Modal.css';

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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: it takes focus, keeps Tab inside, closes on Escape and returns focus to what opened it.
 * The application behind it is inert while it is open.
 */
export function Modal({ title, children, onClose, tone = 'default', dismissible = true, size = 'md', eyebrow, initialFocus }: ModalProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const firstFocus = useRef(initialFocus);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    const target = firstFocus.current?.current
      ?? panel.current?.querySelector<HTMLElement>('[data-autofocus]')
      ?? panel.current?.querySelector<HTMLElement>('.ui-modal-body input, .ui-modal-body select, .ui-modal-body textarea')
      ?? panel.current;
    target?.focus();
    return () => {
      root?.removeAttribute('inert');
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (dismissible) onClose();
      return;
    }
    if (event.key !== 'Tab' || !panel.current) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (stops.length === 0) {
      event.preventDefault();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    const outside = !panel.current.contains(document.activeElement) || document.activeElement === panel.current;
    if (event.shiftKey && (document.activeElement === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="ui-modal-layer" onKeyDown={onKeyDown}>
      <div className="ui-modal-backdrop" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div ref={panel} className={`ui-modal is-${tone} is-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="ui-modal-head">
          <div>
            {eyebrow && <span className="ui-modal-eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          {dismissible && (
            <button type="button" className="ui-modal-close" onClick={onClose} aria-label="Close">
              <X aria-hidden="true" />
            </button>
          )}
        </header>
        <div className="ui-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
