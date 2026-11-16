// Design follows SPHERE frontend/src/modules/pricing/components/pricing-import-modal/index.tsx (revision 73779a8a); no code copied
import { useId, useState, type ChangeEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Action } from '../../modules/core/components/action-button';
import { Modal } from '../../modules/core/components/modal';
import { languageApi } from '../../entities/composition/api';
import { readApiError } from '../../modules/core/api/errors';
import type { ValidateResult } from '../../modules/core/api/types';
import { UPLOAD_LIMIT_BYTES } from './useCompositionEditor';

/** The file as text (`Blob.text`, or a FileReader where a browser has no `text`). */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} couldn’t be read.`));
    reader.readAsText(file);
  });
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What the lint said of the file, in words. */
function verdict(result: ValidateResult): string {
  const errors = result.diagnostics.filter(item => item.severity === 'error').length;
  const warnings = result.diagnostics.filter(item => item.severity === 'warning').length;
  if (!errors && !warnings) return 'The gateway found no problems in this file.';
  const parts = [
    errors ? plural(errors, 'error', 'errors') : '',
    warnings ? plural(warnings, 'warning', 'warnings') : '',
  ].filter(Boolean);
  return `The gateway found ${parts.join(' and ')}. Open it to see where, and fix them before sealing.`;
}

/**
 * Start a version from a Composition2Yaml file: it is read as text (at most 256 KiB, the gateway's own limit), linted, and opened
 * as a new draft of the editor. Over unsaved changes the editor asks first.
 */
export function UploadDialog({
  onClose,
  onLoad,
}: {
  onClose: () => void;
  onLoad: (text: string) => void;
}) {
  const inputId = useId();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<ValidateResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    setFile(null);
    setResult(null);
    setError('');
    if (!chosen) return;
    if (chosen.size > UPLOAD_LIMIT_BYTES) {
      setError(`${chosen.name} is larger than 256 KiB, the largest document the gateway reads.`);
      return;
    }
    setBusy(true);
    try {
      const text = await readText(chosen);
      setFile({ name: chosen.name, text });
      setResult(await languageApi.validate(text));
    } catch (caught) {
      setError(
        readApiError(caught).message || `${chosen.name} couldn’t be checked. You can still open it.`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Upload Composition2Yaml" size="md" onClose={() => !busy && onClose()}>
      <div className="org-dialog-form">
        <div className="ui-field">
          <label htmlFor={inputId}>Composition2Yaml file</label>
          <input
            id={inputId}
            type="file"
            accept=".yml,.yaml"
            onChange={event => void choose(event)}
            disabled={busy}
          />
        </div>
        <p className="org-muted">
          The file opens as a new draft of this editor. Nothing is sealed until you seal it.
        </p>
        <div aria-live="polite">
          {busy && (
            <p className="org-muted" role="status">
              Checking the file…
            </p>
          )}
          {file && result && <p className="ce-upload-verdict">{verdict(result)}</p>}
          {error && (
            <div className="org-dialog-error" role="alert">
              <TriangleAlert aria-hidden="true" />
              {error}
            </div>
          )}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action
            variant="primary"
            disabled={!file || busy}
            onClick={() => {
              if (file) onLoad(file.text);
            }}
          >
            Open in the editor
          </Action>
        </div>
      </div>
    </Modal>
  );
}
