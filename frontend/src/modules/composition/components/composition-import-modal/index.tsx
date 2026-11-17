// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-import-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a Composition2Yaml file sealed as a new version of the composition through the gateway (at most 256 KiB, its own
// limit); what the gateway finds in a refused file is listed by line; drawn in OpenBinding's modal (a focus trap and
// Escape, which SPHERE's lacked).

import { useState } from 'react';
import { readApiError, type ApiError } from '../../../core/api/errors';
import FileUpload from '../../../core/components/file-upload-input';
import { Modal } from '../../../core/components/modal';
import { compositionsApi } from '../../api/compositionsApi';

/** The largest document the gateway reads. */
export const UPLOAD_LIMIT_BYTES = 256 * 1024;

interface CompositionImportModalProps {
  org: string;
  slug: string;
  compositionName: string;
  /** The version was sealed (or the same text already was): its label, and whether it is new. */
  onImported: (label: string, created: boolean) => void;
  onClose: () => void;
}

export default function CompositionImportModal({
  org,
  slug,
  compositionName,
  onImported,
  onClose,
}: CompositionImportModalProps) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState('');

  const importFile = async (file: File) => {
    setRefusal(null);
    setProblem('');
    if (file.size > UPLOAD_LIMIT_BYTES) {
      setProblem(`${file.name} is larger than 256 KiB, the largest document the gateway reads.`);
      return;
    }
    setBusy(true);
    try {
      const sealed = await compositionsApi.seal(org, slug, await file.text());
      onImported(sealed.result.version.label, sealed.created);
    } catch (caught) {
      setRefusal(readApiError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a new version" size="md" onClose={() => !busy && onClose()}>
      <p className="mb-4 text-center text-sm text-tp-steel">
        Upload a Composition2Yaml file. It becomes the next version of{' '}
        <span className="font-medium text-tp-ink">{compositionName}</span> once the gateway has
        checked it.
      </p>
      <FileUpload
        onSubmit={file => void importFile(file)}
        submitButtonText={busy ? 'Sealing…' : 'Upload version'}
        isDragActiveText="Drop the Composition2Yaml file here"
        isNotDragActiveText="Drag and drop a Composition2Yaml file here"
        accept={{ 'application/yaml': ['.yaml', '.yml'], 'text/yaml': ['.yaml', '.yml'] }}
        disabled={busy}
      />
      {(problem || refusal) && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p>{problem || refusal?.message || 'The version could not be sealed.'}</p>
          {refusal && refusal.diagnostics.length > 0 && (
            <ul
              className="mt-2 list-disc space-y-1 pl-5 text-xs"
              aria-label="What the gateway found"
            >
              {refusal.diagnostics.map((finding, index) => (
                <li key={`${finding.code}-${index}`}>
                  {finding.message} <code className="font-mono">{finding.code}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
