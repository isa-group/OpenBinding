// Pattern only, after SPHERE frontend/src/modules/organization/pages/create-organization/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's form field (a small medium-weight label over an h-11 rounded input with the input tokens and a
// primary focus ring); the note is read with the input.

import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';

interface FormFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** A refusal for this field: replaces the hint, marks the input invalid and is announced with it. */
  error?: string;
  hint?: ReactNode;
  /** How the hint reads: neutral help, or confirmation that the value is fine. */
  hintTone?: 'neutral' | 'ok';
  /** Set the value in monospace (usernames, tokens). */
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** The widest the field may grow, as a CSS length. */
  maxWidth?: string;
}

/** A labelled input whose note (hint or error) is read together with it. */
export function FormField({
  label,
  error,
  hint,
  hintTone = 'neutral',
  mono = false,
  inputRef,
  maxWidth,
  className = '',
  ...input
}: FormFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div
      className={`ui-field flex min-w-0 flex-col gap-1.5 ${className}`.trim()}
      style={maxWidth ? { maxWidth } : undefined}
    >
      <label htmlFor={id} className="text-sm font-medium text-tp-ink">
        {label}
      </label>
      <input
        {...input}
        id={id}
        ref={inputRef}
        className={`h-11 w-full rounded-md border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none placeholder:text-tp-steel focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/20 ${
          error ? 'border-tp-error-strong' : 'border-tp-input-border'
        }${mono ? ' is-mono font-mono' : ''}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
      />
      {note && (
        <span
          id={noteId}
          className={`ui-field-note text-xs ${error ? 'is-error text-tp-error-strong' : hintTone === 'ok' ? 'is-ok text-tp-success-strong' : 'text-tp-steel'}`}
        >
          {note}
        </span>
      )}
    </div>
  );
}
