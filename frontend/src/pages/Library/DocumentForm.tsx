import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { FileSummary, ViewSource } from './ContentView';
import { catalogOf, isObject, rulesOf, type Content } from './contentModel';
import { GenericEditor } from './GenericEditor';
import { CatalogEditor, RulesEditor } from './TableEditors';

interface DocumentFormProps {
  kind: string;
  content: Content;
  onChange: (next: Content) => void;
  readOnly: boolean;
}

/** Replacing a text file is the only way to change one: the file is described here, never opened for typing. */
function FileEditor({ kind, content, onChange, readOnly }: DocumentFormProps & { content: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  return (
    <div className="lib-content">
      <FileSummary kind={kind} text={content} />
      {!readOnly && (
        <div className="lib-file-actions">
          <input
            ref={input}
            type="file"
            className="sr-only"
            accept=".bpmn,.xml,.txt,text/plain,text/xml,application/xml"
            aria-label="Replace the file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              file.text().then(
                (text) => { setError(''); onChange(text); },
                () => setError('That file couldn’t be read.'),
              );
            }}
          />
          <Action variant="secondary" onClick={() => input.current?.click()}><Upload aria-hidden="true" className="org-inline-icon" />Replace file…</Action>
          <span className="lib-footnote">Pick a {kind === 'BPMN' ? '.bpmn' : 'text or XML'} file from your computer. It replaces this one in the draft.</span>
        </div>
      )}
      {error && <p className="lib-error-text" role="alert">{error}</p>}
      <ViewSource content={content} />
    </div>
  );
}

/**
 * The editor of a draft: always forms. Candidate catalogs and rules get tables, text files are replaced rather than typed, and every
 * other kind is edited field by field. The source is never an editor; it is a read-only view behind a control.
 */
export function DocumentForm({ kind, content, onChange, readOnly }: DocumentFormProps) {
  if (typeof content === 'string') return <FileEditor kind={kind} content={content} onChange={onChange} readOnly={readOnly} />;
  const catalog = kind === 'CandidateCatalog' ? catalogOf(content) : null;
  const rules = kind === 'ConstraintSet' ? rulesOf(content) : null;
  return (
    <div className="lib-editor">
      {catalog && <CatalogEditor document={content} catalog={catalog} onChange={onChange} readOnly={readOnly} />}
      {!catalog && rules && <RulesEditor document={content} rules={rules} onChange={onChange} readOnly={readOnly} />}
      {!catalog && !rules && (
        <section className="lib-card" aria-label="Fields">
          <header><h3>Fields</h3><span>{isObject(content) ? `${Object.keys(content).length} at the top` : ''}</span></header>
          <GenericEditor document={content} onChange={onChange} readOnly={readOnly} />
        </section>
      )}
      <ViewSource content={content} />
    </div>
  );
}
