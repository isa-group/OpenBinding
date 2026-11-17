// Adapted from SPHERE frontend/src/modules/profile/components/selectable-pricing-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a choice of the study form (a problem version, an engine mode, a run preset) instead of a pricing: a real checkbox
// laid over the whole card (SPHERE's card was a clickable div, out of reach of the keyboard), a second line, chips, a disabled state
// that says why, and the theme's tokens for the border and the check.

import type { ReactNode } from 'react';
import { FaCheck } from 'react-icons/fa6';

interface Props {
  title: ReactNode;
  detail?: ReactNode;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** The checkbox's name when the title alone does not say it. */
  ariaLabel?: string;
  describedBy?: string;
}

export default function SelectableVersionCard({
  title,
  detail,
  selected,
  onToggle,
  disabled = false,
  ariaLabel,
  describedBy,
}: Props) {
  return (
    <label
      className={`relative flex items-start gap-2 rounded-[10px] px-4 py-2 transition-[border,box-shadow] duration-300 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-tp-primary/40 ${
        disabled
          ? 'cursor-not-allowed border border-tp-hairline-soft opacity-60'
          : selected
            ? 'cursor-pointer border-2 border-tp-primary'
            : 'cursor-pointer border border-tp-hairline-strong hover:border-tp-hairline'
      }`}
    >
      <input
        type="checkbox"
        className="absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none rounded-[10px] opacity-0 disabled:cursor-not-allowed"
        checked={selected}
        disabled={disabled}
        onChange={onToggle}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
      />
      <span className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-1.5 text-sm text-tp-ink">{title}</span>
        {detail && <small className="text-[11px] text-tp-steel">{detail}</small>}
      </span>
      {selected && (
        <span
          className="absolute -top-2.5 -right-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-tp-accent text-[10px] text-tp-on-primary"
          aria-hidden="true"
        >
          <FaCheck />
        </span>
      )}
    </label>
  );
}
