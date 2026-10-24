import { useCopy } from '../ui/useCopy';
import { saveText } from './download';
import './SourceView.css';

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

/** The only place that may stringify an object source and render it in a `<pre>`: read-only, copyable, downloadable. */
// [impl->req~frontend-rendering-source-view~1]
export function SourceView({ source, label, language, filename, maxHeight }: SourceViewProps) {
  const { copy, status } = useCopy();
  const state = status();
  const isObject = typeof source !== 'string';
  const text = isObject ? JSON.stringify(source, null, 2) : source;

  const download = () => saveText(text, filename ?? '', isObject ? 'application/json' : 'text/plain');

  return (
    <section className="rendering-source" role="region" aria-label={label} data-language={language}>
      <div className="rendering-source__bar">
        <button type="button" className={state === 'idle' ? undefined : `is-${state}`} aria-label={`Copy ${label}`} onClick={() => void copy(text)}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
        </button>
        {filename && <button type="button" aria-label={`Download ${label}`} onClick={download}>Download</button>}
        <span className="sr-only" role="status">{state === 'copied' ? `${label} copied` : state === 'failed' ? `Could not copy the ${label}` : ''}</span>
      </div>
      <pre tabIndex={0} style={maxHeight ? { maxHeight } : undefined}>
        {text === '' ? <span className="rendering-source__empty">Empty</span> : <code>{text}</code>}
      </pre>
    </section>
  );
}
