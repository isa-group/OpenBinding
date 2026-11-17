import { useState } from 'react';
import { useCopy } from '../../../core/hooks/useCopy';
import { saveText } from './download';

interface LogPanelProps {
  log: string;
  title?: string;
  /** Offers a Download button that saves the whole log under this name. */
  filename?: string;
  defaultOpen?: boolean;
}

const BUTTON =
  'min-h-6 cursor-pointer rounded border bg-tp-canvas px-2.5 py-0.5 text-xs text-tp-ink transition-colors hover:bg-tp-surface';
const STATE = {
  idle: 'border-tp-hairline-strong',
  copied: 'border-tp-severity-success text-tp-success-text',
  failed: 'border-tp-severity-error text-tp-error-text',
} as const;

/** A collapsible, searchable log with stable line numbers. One of the two places that may render a `<pre>`. */
export function LogPanel({ log, title = 'Log', filename, defaultOpen = false }: LogPanelProps) {
  const [query, setQuery] = useState('');
  const { copy, status } = useCopy();
  const state = status();
  const lines = log === '' ? [] : log.replace(/\r?\n$/, '').split(/\r?\n/);
  const needle = query.toLowerCase();
  const shown = lines.flatMap((text, i) =>
    text.toLowerCase().includes(needle) ? [{ n: i + 1, text }] : []
  );

  const download = () => saveText(log, filename ?? '', 'text/plain');

  return (
    <details
      className="max-w-full min-w-0 overflow-hidden rounded-lg border border-tp-hairline bg-tp-surface"
      open={defaultOpen}
      data-rendering="log"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-tp-ink">
        {title} ({lines.length} {lines.length === 1 ? 'line' : 'lines'})
      </summary>
      {lines.length === 0 ? (
        <p className="m-0 px-3 py-1.5 text-xs text-tp-steel">No log</p>
      ) : (
        <>
          <div className="flex gap-2 px-3">
            <input
              className="min-w-0 flex-1 rounded border border-tp-hairline-strong bg-tp-canvas px-2 py-1 text-sm text-tp-ink outline-none focus:border-tp-primary"
              type="search"
              aria-label="Search the log"
              placeholder="Search"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <button
              type="button"
              className={`${BUTTON} ${STATE[state]}`}
              aria-label={`Copy ${title}`}
              onClick={() => void copy(log)}
            >
              {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
            </button>
            {filename && (
              <button
                type="button"
                aria-label={`Download ${title}`}
                onClick={download}
                className={`${BUTTON} ${STATE.idle}`}
              >
                Download
              </button>
            )}
          </div>
          <p role="status" className="m-0 px-3 py-1.5 text-xs text-tp-steel">
            {shown.length} of {lines.length} {lines.length === 1 ? 'line' : 'lines'}
            {state === 'copied' && ` · ${title} copied`}
            {state === 'failed' && ` · Could not copy the ${title}`}
          </p>
          {shown.length === 0 ? (
            <p className="m-0 px-3 py-1.5 text-xs text-tp-steel">No lines match</p>
          ) : (
            <pre
              aria-label={title}
              tabIndex={0}
              className="m-0 max-h-96 overflow-auto border-t border-tp-hairline px-3 py-2 font-mono text-[13px] leading-normal text-tp-ink"
            >
              {shown.map(({ n, text }) => (
                <span key={n} data-line={n}>
                  <span
                    className="mr-[1ch] inline-block min-w-[3ch] text-right text-tp-muted select-none"
                    aria-hidden="true"
                  >
                    {n}
                  </span>
                  {text}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </>
      )}
    </details>
  );
}
