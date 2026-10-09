import { useState } from 'react';
import { parseNumber } from './contentModel';

interface NumberFieldProps {
  value: number | null;
  /** `null` when the field is cleared. Never called with text that isn't a number. */
  onChange: (value: number | null) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  /** Shown beside the label as a hint when the value is missing. */
  required?: boolean;
  className?: string;
}

/**
 * A number typed by hand. What is typed is kept as typed (`0.` stays `0.` while the next digit is on its way) and only a complete
 * number reaches the document; text that isn't a number is flagged and leaves the document as it was.
 */
export function NumberField({ value, onChange, label, id, disabled, required, className = '' }: NumberFieldProps) {
  const [typed, setTyped] = useState<{ text: string; value: number | null } | null>(null);
  const current = typed && typed.value === value ? typed.text : null;
  const shown = current ?? (value === null ? '' : String(value));
  const invalid = current !== null && current.trim() !== '' && parseNumber(current) === undefined;
  const missing = required && value === null && !invalid;

  return (
    <input
      id={id}
      className={`lib-input is-number ${className}`.trim()}
      inputMode="decimal"
      autoComplete="off"
      aria-label={id ? undefined : label}
      aria-invalid={invalid || missing || undefined}
      value={shown}
      disabled={disabled}
      onChange={(event) => {
        const text = event.target.value;
        if (text.trim() === '') {
          setTyped({ text, value: null });
          onChange(null);
          return;
        }
        const parsed = parseNumber(text);
        if (parsed === undefined) {
          setTyped({ text, value });
          return;
        }
        setTyped({ text, value: parsed });
        onChange(parsed);
      }}
    />
  );
}

interface CommitFieldProps {
  value: string;
  /** Called with a trimmed, non-empty, unused name when the field is left (or Enter is pressed). */
  onCommit: (value: string) => void;
  label: string;
  disabled?: boolean;
  /** Names already in use by other rows. */
  taken?: string[];
}

/** A name that is only applied when it is complete and free: renaming a row mid-word would otherwise rebuild it on every key. */
export function CommitField({ value, onCommit, label, disabled, taken = [] }: CommitFieldProps) {
  const [typed, setTyped] = useState<{ text: string; of: string } | null>(null);
  const [error, setError] = useState('');
  const shown = typed && typed.of === value ? typed.text : value;

  const commit = () => {
    if (shown === value) {
      setTyped(null);
      setError('');
      return;
    }
    const next = shown.trim();
    if (!next) {
      setError('A name is needed.');
      return;
    }
    if (taken.includes(next)) {
      setError(`“${next}” is already used.`);
      return;
    }
    setTyped(null);
    setError('');
    onCommit(next);
  };

  return (
    <>
      <input
        className="lib-input is-mono"
        type="text"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        value={shown}
        disabled={disabled}
        onChange={(event) => { setTyped({ text: event.target.value, of: value }); setError(''); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      />
      {error && <span className="lib-cell-error" role="alert">{error}</span>}
    </>
  );
}

interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  mono?: boolean;
  placeholder?: string;
  className?: string;
}

/** A line of text whose accessible name is its label even when no label is drawn (table cells). */
export function TextField({ value, onChange, label, id, disabled, mono, placeholder, className = '' }: TextFieldProps) {
  return (
    <input
      id={id}
      className={`lib-input${mono ? ' is-mono' : ''} ${className}`.trim()}
      type="text"
      autoComplete="off"
      spellCheck={false}
      aria-label={id ? undefined : label}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
