import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal's keyboard contract, taken out of OpenBinding's Modal: on mount the panel takes focus (`[data-autofocus]`, or the
 * panel itself), the application behind it (`#root`) turns inert, Tab and Shift+Tab stay inside, Escape asks to close, and
 * focus goes back to whatever opened it. The panel must be rendered outside `#root` (a portal to `document.body`).
 * Returns the keydown handler for the element that wraps the panel.
 */
export function useFocusTrap(
  panel: RefObject<HTMLElement | null>,
  {
    onEscape,
    initialFocus,
    fallbackSelector,
  }: {
    onEscape?: () => void;
    /** The element that gets focus first, before `[data-autofocus]`. */
    initialFocus?: RefObject<HTMLElement | null>;
    /** Where to look for the first focus after `[data-autofocus]` (the first field of a form, say). */
    fallbackSelector?: string;
  } = {}
) {
  const escape = useRef(onEscape);
  const first = useRef({ initialFocus, fallbackSelector });
  useEffect(() => {
    escape.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    const wasInert = root?.hasAttribute('inert') ?? false;
    root?.setAttribute('inert', '');
    const { initialFocus: preferred, fallbackSelector: fallback } = first.current;
    const target =
      preferred?.current ??
      panel.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      (fallback ? panel.current?.querySelector<HTMLElement>(fallback) : null) ??
      panel.current;
    target?.focus();
    return () => {
      if (!wasInert) root?.removeAttribute('inert');
      if (opener?.isConnected) opener.focus();
    };
  }, [panel]);

  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      escape.current?.();
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
    const outside =
      !panel.current.contains(document.activeElement) || document.activeElement === panel.current;
    if (event.shiftKey && (document.activeElement === first || outside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || outside)) {
      event.preventDefault();
      first.focus();
    }
  };
}
