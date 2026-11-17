// The modal contract of OpenBinding's Modal (core/hooks/useFocusTrap), for a dialog drawn with its own markup (SPHERE's
// confirm, publish and side-sheet dialogs): the dialog renders in a layer outside the application (a portal to the body),
// the application turns inert, focus moves in and stays there, Escape closes, and focus returns to what opened it.

import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface FocusTrapLayerProps {
  /** What Escape does; omit it for a dialog Escape must not close. */
  onEscape?: () => void;
  children: ReactNode;
}

export default function FocusTrapLayer({ onEscape, children }: FocusTrapLayerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const onKeyDown = useFocusTrap(layer, {
    onEscape,
    fallbackSelector: 'input:not([disabled]), select, textarea, button:not([disabled]), a[href]',
  });
  return createPortal(
    <div ref={layer} onKeyDown={onKeyDown}>
      {children}
    </div>,
    document.body
  );
}
