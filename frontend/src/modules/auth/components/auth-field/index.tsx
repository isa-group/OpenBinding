// Pattern only, after SPHERE frontend/src/modules/auth/components/login-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// SPHERE's label, input and spinner recipe around OpenBinding's field: a hint or a refusal announced with the input
// (`aria-describedby`), `aria-invalid` on a refusal, and slots for the "Forgot password?" link and the strength meter.

import { motion } from 'framer-motion';
import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { fadeUp } from '../auth-layout/variants';

const INPUT =
  'h-11 w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-4 text-sm text-tp-ink outline-none transition-all duration-200 placeholder:text-tp-muted focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/10 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red-600 aria-invalid:focus:ring-red-600/15 dark:focus:ring-tp-primary/20';

interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  label: string;
  /** A refusal for this field; replaces the hint and marks the input invalid. */
  error?: string;
  /** Marks the input invalid when the refusal is about the form as a whole and has no sentence of its own here. */
  invalid?: boolean;
  hint?: string;
  /** How the hint reads: neutral help, or a confirmation that the value is fine. */
  hintTone?: 'neutral' | 'ok';
  /** Something on the label row's right edge (the "Forgot password?" link). */
  aside?: ReactNode;
  /** Something under the input, before its note (a strength meter). */
  below?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
}

/** A labelled input whose note (hint or error) is announced with it. */
export function AuthField({
  id,
  label,
  error,
  invalid,
  hint,
  hintTone = 'neutral',
  aside,
  below,
  inputRef,
  ...input
}: AuthFieldProps) {
  const note = error ?? hint;
  const noteId = `${id}-note`;
  return (
    <motion.div variants={fadeUp}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={id} className="block text-sm font-medium text-tp-ink">
          {label}
        </label>
        {aside}
      </div>
      <input
        {...input}
        id={id}
        ref={inputRef}
        className={INPUT}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={note ? noteId : undefined}
      />
      {below}
      {note && (
        <p
          id={noteId}
          className={`mt-1.5 text-xs ${
            error ? 'text-red-700' : hintTone === 'ok' ? 'text-emerald-700' : 'text-tp-steel'
          }`}
        >
          {note}
        </p>
      )}
    </motion.div>
  );
}

/** SPHERE's spinner, shown inside a busy button. */
export function AuthSpinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
