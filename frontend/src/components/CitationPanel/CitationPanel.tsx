import { useId } from 'react';
import { CopyField } from '../ui/CopyField';
import { useCopy } from '../ui/useCopy';
import { buildPanelCitation, type CitationInput } from './citationModel';
import './CitationPanel.css';

export interface CitationPanelProps extends CitationInput {
  /** The one place the digest is shown, as a copyable value. Omitted when the record has none. */
  digest?: string | null;
}

const COPIES = [
  { key: 'text', name: 'citation text', copied: 'Citation text copied' },
  { key: 'bibtex', name: 'BibTeX', copied: 'BibTeX copied' },
  { key: 'csl', name: 'CSL-JSON', copied: 'CSL-JSON copied' },
] as const;

/** Permanent link, citation (text, BibTeX, CSL-JSON) and the one copyable digest of a problem, collection or published result. */
// [impl->req~citation-panel~1]
export function CitationPanel({ digest, ...source }: CitationPanelProps) {
  const headingId = useId();
  const { copy, status } = useCopy();
  const citation = buildPanelCitation(source);
  // useCopy keeps only the latest outcome, so at most one key reports.
  const pressed = COPIES.find(({ key }) => status(key) !== 'idle');
  const outcome = pressed ? (status(pressed.key) === 'copied' ? pressed.copied : `Could not copy the ${pressed.name}`) : '';

  return (
    <section className="citation-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>Cite and link</h2>

      <div className="citation-panel__field">
        <span className="citation-panel__label">Permanent link</span>
        <CopyField value={source.url} label="permanent link" />
      </div>

      <div className="citation-panel__field">
        <span className="citation-panel__label">Cite as</span>
        <p className="citation-panel__text">{citation.text}</p>
        <div className="citation-panel__actions">
          <button type="button" onClick={() => void copy(citation.text, 'text')}>
            {status('text') === 'copied' ? 'Citation copied' : 'Copy citation'}
          </button>
          <button type="button" onClick={() => void copy(citation.bibtex, 'bibtex')}>
            {status('bibtex') === 'copied' ? 'BibTeX copied' : 'Copy BibTeX'}
          </button>
          <button type="button" onClick={() => void copy(citation.cslJson, 'csl')}>
            {status('csl') === 'copied' ? 'CSL-JSON copied' : 'Copy CSL-JSON'}
          </button>
        </div>
        <span className="sr-only" role="status">
          {outcome}
        </span>
      </div>

      {digest && (
        <div className="citation-panel__field">
          <span className="citation-panel__label">Digest</span>
          <CopyField value={digest} label="digest" />
        </div>
      )}
    </section>
  );
}
