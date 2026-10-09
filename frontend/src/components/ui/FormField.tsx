import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import './FormField.css';

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
export function FormField({ label, error, hint, hintTone = 'neutral', mono = false, inputRef, maxWidth, className = '', ...input }: FormFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={`ui-field ${className}`.trim()} style={maxWidth ? { maxWidth } : undefined}>
      <label htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        ref={inputRef}
        className={mono ? 'is-mono' : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
      />
      {note && <span id={noteId} className={`ui-field-note${error ? ' is-error' : hintTone === 'ok' ? ' is-ok' : ''}`}>{note}</span>}
    </div>
  );
}
