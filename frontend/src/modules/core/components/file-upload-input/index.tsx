// Adapted from SPHERE frontend/src/modules/core/components/file-upload-input/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: theme tokens instead of SPHERE's palette module, hex greys and the undefined `sphere-grey-*` classes; the
// default wording names no file format; the warning names the accepted extensions; an empty drop is ignored.

import { useState, useCallback } from 'react';
import { FaUpload } from 'react-icons/fa';
import { useDropzone, type Accept } from 'react-dropzone';
import { MdDeleteForever } from 'react-icons/md';
import customAlert from '../../utils/custom-alert';
import ActionButton from '../action-button';

export default function FileUpload({
  onSubmit,
  submitButtonText,
  submitButtonWidth,
  isDragActiveText,
  isNotDragActiveText,
  accept,
  disabled,
}: {
  onSubmit: (file: File) => void;
  submitButtonText?: string;
  submitButtonWidth?: number;
  isDragActiveText?: string;
  isNotDragActiveText?: string;
  accept?: Accept;
  disabled?: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);

  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const uploadedFile = acceptedFiles[0];
      if (!uploadedFile) return;
      const extensionValidator = accept
        ? Object.values(accept).every(extensions =>
            extensions.some(ext => uploadedFile.name.endsWith(ext))
          )
        : uploadedFile.name.endsWith('.yaml') || uploadedFile.name.endsWith('.yml');

      if (uploadedFile && extensionValidator) {
        setFile(uploadedFile);
      } else {
        const extensions = accept ? Object.values(accept).flat().join(', ') : '.yaml, .yml';
        customAlert(`Please upload a file with one of these extensions: ${extensions}`, 'warning');
      }
    },
    [accept]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: accept ?? {
      'application/x-yaml': ['.yaml', '.yml'],
    },
    maxFiles: 1,
    multiple: false,
  });

  const handleDelete = () => {
    setFile(null);
  };

  const handleSubmit = () => {
    // set editor's value with the contents of the file as a string

    if (!file) {
      return;
    }

    onSubmit(file);
    handleDelete();
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="my-2 w-full">
        <div
          {...getRootProps()}
          className={`border-2 border-dashed border-tp-hairline bg-tp-canvas p-[10px] text-center transition-colors hover:bg-tp-surface ${file ? 'pointer-events-none opacity-50' : 'cursor-pointer opacity-100'}`}
          role="button"
          tabIndex={0}
        >
          <input {...getInputProps()} type="file" className="hidden" />
          <FaUpload className="mx-auto mb-4 block text-5xl text-tp-steel" aria-hidden="true" />
          <h3 className="mt-4 mb-2 text-xl font-semibold text-tp-ink">
            {isDragActive
              ? isDragActiveText
                ? isDragActiveText
                : 'Drop the file here'
              : isNotDragActiveText
                ? isNotDragActiveText
                : 'Drag and drop a file here'}
          </h3>
          <p className="text-sm text-tp-steel">or click to select a file</p>
        </div>

        {file && (
          <ul className="mt-3 divide-y divide-tp-hairline-soft rounded-md border border-tp-hairline-soft">
            <li className="flex items-center justify-between px-3 py-2">
              <div>
                <p className="text-sm font-medium text-tp-ink">{file.name}</p>
                <p className="text-xs text-tp-steel">{`${(file.size / 1024).toFixed(2)} KB`}</p>
              </div>
              <button
                type="button"
                aria-label="Remove the file"
                onClick={handleDelete}
                className="cursor-pointer text-tp-error-strong"
              >
                <MdDeleteForever size={25} aria-hidden="true" />
              </button>
            </li>
          </ul>
        )}
      </div>
      <ActionButton
        text={submitButtonText ?? 'Submit file'}
        onClick={handleSubmit}
        disabled={!file || disabled}
        className={`mt-5 font-bold ${submitButtonWidth ? 'w-auto' : 'w-full'}`}
      />
    </div>
  );
}
