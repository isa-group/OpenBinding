import { useCopy } from '../../components/ui/useCopy';

/** A button that copies a full digest without showing it: the page names the thing, the clipboard carries the proof. */
export function CopyDigest({ value, label }: { value: string; label: string }) {
  const { copy, status } = useCopy();
  const state = status();
  return (
    <button type="button" className="job-link-button" aria-label={label} onClick={() => void copy(value)}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy digest'}
    </button>
  );
}
