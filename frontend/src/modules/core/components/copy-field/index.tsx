// Pattern only, after SPHERE frontend/src/modules/core/components/copy-icon/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's copy field (a bordered value with the copy button attached), in monospace; the button says what
// happened and a status line announces it.

import { useCopy } from '../../hooks/useCopy';

interface CopyFieldProps {
  value: string;
  /** What is being copied, for the button's accessible name: `digest` → "Copy digest". */
  label: string;
  /** Show the value on one line with an ellipsis instead of wrapping. */
  truncate?: boolean;
  className?: string;
}

/** A value in monospace with a Copy button attached: digests, URIs, references. */
export function CopyField({ value, label, truncate = false, className = '' }: CopyFieldProps) {
  const { copy, status } = useCopy();
  const state = status();
  return (
    <div
      className={`ui-copy-field flex w-full min-w-0 overflow-hidden rounded-md border border-tp-hairline bg-tp-canvas ${className}`.trim()}
    >
      <code
        className={`min-w-0 flex-1 border-0 bg-transparent px-2.5 py-2 font-mono text-xs text-tp-ink ${truncate ? 'is-truncated truncate' : 'break-all'}`}
      >
        {value}
      </code>
      <button
        type="button"
        className={`shrink-0 cursor-pointer px-3 text-xs font-medium text-tp-on-primary transition-colors ${
          state === 'copied'
            ? 'is-copied bg-tp-success-strong'
            : state === 'failed'
              ? 'is-failed bg-tp-error-strong'
              : 'bg-tp-accent hover:bg-tp-accent-hover'
        }`}
        aria-label={`Copy ${label}`}
        onClick={() => void copy(value)}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied'
          ? `${label} copied`
          : state === 'failed'
            ? `Could not copy the ${label}`
            : ''}
      </span>
    </div>
  );
}
