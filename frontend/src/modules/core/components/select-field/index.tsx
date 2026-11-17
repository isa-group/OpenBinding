// Pattern only, after SPHERE frontend/src/modules/organization/pages/create-organization/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// The select and the multi-line text of SPHERE's form field (the FormField beside it draws the input): a small
// medium-weight label over a rounded control with the input tokens and a primary focus ring; the note is read with the
// control.

import { useId, type ReactNode, type TextareaHTMLAttributes } from 'react';

const CONTROL =
  'w-full rounded-md border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none placeholder:text-tp-steel focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/20 disabled:cursor-not-allowed disabled:bg-tp-surface';

function Note({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  const note = error ?? hint;
  if (!note) return null;
  return (
    <span id={id} className={`text-xs ${error ? 'text-tp-error-strong' : 'text-tp-steel'}`}>
      {note}
    </span>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
  error?: string;
  /** The widest the field may grow, as a CSS length. */
  maxWidth?: string;
  className?: string;
}

/** A labelled native select whose note (hint or error) is read together with it. */
export function SelectField({
  label,
  value,
  onChange,
  children,
  disabled,
  hint,
  error,
  maxWidth,
  className = '',
}: SelectFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5 ${className}`.trim()}
      style={maxWidth ? { maxWidth } : undefined}
    >
      <label htmlFor={id} className="text-sm font-medium text-tp-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        className={`${CONTROL} h-11 cursor-pointer ${error ? 'border-tp-error-strong' : 'border-tp-input-border'}`}
      >
        {children}
      </select>
      <Note id={noteId} error={error} hint={hint} />
    </div>
  );
}

interface TextAreaFieldProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  error?: string;
  hint?: ReactNode;
  /** Set the text in monospace (JSON, code). */
  mono?: boolean;
}

/** A labelled multi-line text whose note (hint or error) is read together with it. */
export function TextAreaField({
  label,
  error,
  hint,
  mono = false,
  className = '',
  ...textarea
}: TextAreaFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`.trim()}>
      <label htmlFor={id} className="text-sm font-medium text-tp-ink">
        {label}
      </label>
      <textarea
        {...textarea}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        className={`${CONTROL} py-2 ${mono ? 'font-mono text-xs' : ''} ${error ? 'border-tp-error-strong' : 'border-tp-input-border'}`}
      />
      <Note id={noteId} error={error} hint={hint} />
    </div>
  );
}
