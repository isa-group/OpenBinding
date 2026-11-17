// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/editor-header.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the pieces of SPHERE's editor header and dialogs that OpenBinding's two standalone editors (`/editor`,
// `/problem-editor`) share, taken out of the header so both draw them alike: a header menu (File, Export) that is a menu to
// assistive technology and closes on Escape back to its button or on a click outside; its entries; the mode toggle as a pair
// of pressed buttons with SPHERE's sliding background; and the editors' small dialog (SPHERE's backdrop and card), labelled
// by its title and closed on Escape.

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { dropdownVariants, transitionFast } from '../../utils/motion-variants';
import FocusTrapLayer from '../focus-trap-layer';

/** An entry of a header menu: a button with `role="menuitem"`. */
export const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white focus:bg-white/10 focus:text-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-40';

const MENU_BUTTON =
  'cursor-pointer rounded-md px-2 py-1.5 text-xs font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white sm:px-3';

/** A menu of the dark editor header (File, Export). */
export function HeaderMenu({
  label,
  open,
  onOpenChange,
  align,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align: 'left' | 'right';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOpenChange(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <button
        ref={toggle}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={MENU_BUTTON}
      >
        {label}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            variants={dropdownVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={transitionFast}
            role="menu"
            aria-label={label}
            className={`absolute ${align === 'left' ? 'left-0' : 'right-0'} top-full z-50 mt-1 w-[220px] rounded-lg border border-white/10 bg-tp-surface-code py-1 shadow-elevation-4`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The editor's mode toggle: one pressed button per mode, the active one on a sliding background. */
export function ModeToggle<Mode extends string>({
  modes,
  value,
  onChange,
  layoutId,
}: {
  modes: ReadonlyArray<{ id: Mode; label: string }>;
  value: Mode;
  onChange: (mode: Mode) => void;
  /** Unique per editor, so the sliding background of one never animates into another. */
  layoutId: string;
}) {
  return (
    <div
      role="group"
      aria-label="Editor mode"
      className="inline-flex items-center rounded-lg border border-white/10 bg-white/5 p-0.5"
    >
      {modes.map(mode => {
        const isActive = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={isActive}
            onClick={() => {
              if (!isActive) onChange(mode.id);
            }}
            className="relative cursor-pointer rounded-md px-3 py-1 text-[11px] font-medium transition-colors"
          >
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-md bg-white/15"
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
            <span
              className={`relative z-10 ${isActive ? 'text-white' : 'text-white/60 hover:text-white/80'}`}
            >
              {mode.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A dialog of the editors: SPHERE's backdrop and card, labelled by its title, closed on Escape or a click outside. */
export function EditorDialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** A wider card, for a dialog with a form. */
  wide?: boolean;
}) {
  const titleId = useId();
  return (
    <FocusTrapLayer onEscape={onClose}>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-tp-ink/60 p-4"
        role="presentation"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`max-h-[90dvh] w-full overflow-y-auto rounded-xl border border-tp-hairline bg-tp-canvas p-6 shadow-elevation-4 ${wide ? 'max-w-[600px]' : 'max-w-[500px]'}`}
          onClick={event => event.stopPropagation()}
        >
          <h2 id={titleId} className="text-center font-display text-lg font-semibold text-tp-ink">
            {title}
          </h2>
          {children}
        </motion.div>
      </motion.div>
    </FocusTrapLayer>
  );
}
