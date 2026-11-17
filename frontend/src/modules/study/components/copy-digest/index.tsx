import { useCopy } from '../../../core/hooks/useCopy';

/** A button that copies a full digest without showing it: the page names the thing, the clipboard carries the proof. */
export function CopyDigest({ value, label }: { value: string; label: string }) {
  const { copy, status } = useCopy();
  const state = status();
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy(value)}
      className="cursor-pointer text-xs font-medium text-tp-accent underline-offset-2 hover:underline"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy digest'}
    </button>
  );
}
