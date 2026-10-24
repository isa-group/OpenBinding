import { useState } from 'react';
import { useCopy } from '../ui/useCopy';
import { saveText } from './download';
import './LogPanel.css';

interface LogPanelProps {
  log: string;
  title?: string;
  /** Offers a Download button that saves the whole log under this name. */
  filename?: string;
  defaultOpen?: boolean;
}

/** A collapsible, searchable log with stable line numbers. One of the two places that may render a `<pre>`. */
// [impl->req~frontend-rendering-log-panel~1]
export function LogPanel({ log, title = 'Log', filename, defaultOpen = false }: LogPanelProps) {
  const [query, setQuery] = useState('');
  const { copy, status } = useCopy();
  const state = status();
  const lines = log === '' ? [] : log.replace(/\r?\n$/, '').split(/\r?\n/);
  const needle = query.toLowerCase();
  const shown = lines.flatMap((text, i) => (text.toLowerCase().includes(needle) ? [{ n: i + 1, text }] : []));

  const download = () => saveText(log, filename ?? '', 'text/plain');

  return (
    <details className="rendering-log" open={defaultOpen}>
      <summary>{title} ({lines.length} {lines.length === 1 ? 'line' : 'lines'})</summary>
      {lines.length === 0 ? (
        <p className="rendering-log__empty">No log</p>
      ) : (
        <>
          <div className="rendering-log__bar">
            <input type="search" aria-label="Search the log" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button type="button" className={state === 'idle' ? undefined : `is-${state}`} aria-label={`Copy ${title}`} onClick={() => void copy(log)}>
              {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
            </button>
            {filename && <button type="button" aria-label={`Download ${title}`} onClick={download}>Download</button>}
          </div>
          <p role="status" className="rendering-log__count">
            {shown.length} of {lines.length} {lines.length === 1 ? 'line' : 'lines'}
            {state === 'copied' && ` · ${title} copied`}
            {state === 'failed' && ` · Could not copy the ${title}`}
          </p>
          {shown.length === 0 ? (
            <p className="rendering-log__empty">No lines match</p>
          ) : (
            <pre aria-label={title} tabIndex={0}>
              {shown.map(({ n, text }) => (
                <span key={n} data-line={n} className="rendering-log__line">
                  <span className="rendering-log__num" aria-hidden="true">{n}</span>
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
