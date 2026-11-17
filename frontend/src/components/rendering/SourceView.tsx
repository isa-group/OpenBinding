import { useCopy } from '../../modules/core/hooks/useCopy';
import { saveText } from './download';

interface SourceViewProps {
  /** A string is shown as is; an object is shown as indented JSON. */
  source: string | object;
  /** What the source is, for the region and button names: `BIM source` → "Copy BIM source". */
  label: string;
  language?: string;
  /** Offers a Download button that saves the source under this name. */
  filename?: string;
  /** CSS max-height of the scrolling area, e.g. `24rem`. */
  maxHeight?: string;
}

const BUTTON =
  'min-h-6 cursor-pointer rounded border bg-tp-canvas px-2.5 py-0.5 text-xs text-tp-ink transition-colors hover:bg-tp-surface';
const STATE = {
  idle: 'border-tp-hairline-strong',
  copied: 'border-tp-severity-success text-tp-success-text',
  failed: 'border-tp-severity-error text-tp-error-text',
} as const;

/** The only place that may stringify an object source and render it in a `<pre>`: read-only, copyable, downloadable. */
export function SourceView({ source, label, language, filename, maxHeight }: SourceViewProps) {
  const { copy, status } = useCopy();
  const state = status();
  const isObject = typeof source !== 'string';
  const text = isObject ? JSON.stringify(source, null, 2) : source;

  const download = () =>
    saveText(text, filename ?? '', isObject ? 'application/json' : 'text/plain');

  return (
    <section
      className="max-w-full overflow-hidden rounded-lg border border-tp-hairline bg-tp-surface"
      role="region"
      aria-label={label}
      data-language={language}
      data-rendering="source"
    >
      <div className="flex justify-end gap-2 border-b border-tp-hairline px-2 py-1">
        <button
          type="button"
          className={`${BUTTON} ${STATE[state]}`}
          aria-label={`Copy ${label}`}
          onClick={() => void copy(text)}
        >
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
        </button>
        {filename && (
          <button
            type="button"
            aria-label={`Download ${label}`}
            onClick={download}
            className={`${BUTTON} ${STATE.idle}`}
          >
            Download
          </button>
        )}
        <span className="sr-only" role="status">
          {state === 'copied'
            ? `${label} copied`
            : state === 'failed'
              ? `Could not copy the ${label}`
              : ''}
        </span>
      </div>
      <pre
        tabIndex={0}
        style={maxHeight ? { maxHeight } : undefined}
        className="m-0 overflow-auto p-3 font-mono text-[13px] leading-normal [tab-size:2] text-tp-ink"
      >
        {text === '' ? (
          <span className="font-sans text-tp-steel italic">Empty</span>
        ) : (
          <code>{text}</code>
        )}
      </pre>
    </section>
  );
}
