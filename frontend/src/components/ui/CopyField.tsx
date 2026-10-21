import { useCopy } from './useCopy';
import './CopyField.css';

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
    <div className={`ui-copy-field ${className}`.trim()}>
      <code className={truncate ? 'is-truncated' : undefined}>{value}</code>
      <button
        type="button"
        className={state === 'copied' ? 'is-copied' : state === 'failed' ? 'is-failed' : undefined}
        aria-label={`Copy ${label}`}
        onClick={() => void copy(value)}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
      </button>
      <span className="sr-only" role="status">{state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy the ${label}` : ''}</span>
    </div>
  );
}
