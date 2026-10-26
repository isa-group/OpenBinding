import { useState } from 'react';
import { parseFiniteNumber as parseNumber } from '../../utils/featureRange';

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
