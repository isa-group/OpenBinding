// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-import-modal/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a BIM package (`.bim.zip`) uploaded as a new problem of the organization (with its name, address and
// description; the organization is the one the tab belongs to) or as the next version of a problem. The package is compiled
// once by the gateway: a refusal lists where it is wrong, a taken address and a full plan say so, and nothing is created.
// SPHERE's dropzone is drawn here with the picked file named under it, so the name can follow the file; drawn in
// OpenBinding's modal (a focus trap and Escape, which SPHERE's lacked).

import { useState, type FormEvent } from 'react';
import { useDropzone } from 'react-dropzone';
import { FaUpload } from 'react-icons/fa';
import { MdDeleteForever } from 'react-icons/md';
import { problemsApi, type Problem, type ProblemUpload } from '../../api/problemsApi';
import { Action } from '../../../core/components/action-button';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import { SLUG_PATTERN, slugFromName } from '../../../core/utils/slug';
import type { ProblemOrg } from '../../types';
import { uploadRefusal, type Refusal } from '../../utils/problemErrors';
import { DESCRIPTION_MAX, NAME_MAX } from '../../utils/problemsModel';

/** The producer an upload names: the gateway records the version's origin as `upload` from it. */
export const UPLOAD_PRODUCER = 'openbinding-upload';

/** The name a file suggests for a problem: `simple-seq.bim.zip` → `simple-seq`. */
const nameOfFile = (file: File): string => file.name.replace(/\.bim\.zip$|\.zip$/i, '');

export function RefusalText({ refusal }: { refusal: Refusal }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-tp-severity-error-border bg-tp-severity-error-bg p-3 text-sm text-tp-error-text"
    >
      <p>{refusal.text}</p>
      {refusal.diagnostics && refusal.diagnostics.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs" aria-label="What the compiler found">
          {refusal.diagnostics.slice(0, 8).map((item, index) => (
            <li key={`${item.code}-${index}`}>
              {item.resource && <code className="mr-1 font-mono">{item.resource}</code>}
              {item.pointer && <code className="mr-1 font-mono">{item.pointer}</code>}
              {item.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** SPHERE's dropzone for one package: drop it or pick it; the file picked is named under it, with a way to remove it. */
function PackageDrop({
  file,
  onPick,
  disabled,
}: {
  file: File | null;
  onPick: (file: File | null) => void;
  disabled?: boolean;
}) {
  const [rejected, setRejected] = useState(false);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted, refused) => {
      setRejected(refused.length > 0 && accepted.length === 0);
      if (accepted[0]) onPick(accepted[0]);
    },
    accept: { 'application/zip': ['.zip'], 'application/vnd.bim+zip': ['.zip'] },
    maxFiles: 1,
    multiple: false,
    disabled,
  });
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="problem-package" className="text-sm font-medium text-tp-ink">
        BIM package
      </label>
      <div
        {...getRootProps()}
        className={`rounded-lg border-2 border-dashed border-tp-hairline-strong bg-tp-canvas p-5 text-center transition-colors ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-tp-surface'}`}
      >
        <input {...getInputProps({ id: 'problem-package' })} />
        <FaUpload className="mx-auto mb-2 block text-3xl text-tp-steel" aria-hidden="true" />
        <p className="text-sm font-semibold text-tp-ink">
          {isDragActive ? 'Drop the package here' : 'Drag and drop a .bim.zip package here'}
        </p>
        <p className="text-xs text-tp-steel">or click to select it</p>
      </div>
      {file ? (
        <div className="flex items-center justify-between rounded-md border border-tp-hairline-soft px-3 py-2">
          <div>
            <p className="text-sm font-medium text-tp-ink">{file.name}</p>
            <p className="text-xs text-tp-steel">{`${file.size.toLocaleString('en-US')} bytes`}</p>
          </div>
          <button
            type="button"
            aria-label="Remove the package"
            disabled={disabled}
            onClick={() => onPick(null)}
            className="cursor-pointer text-tp-error-strong"
          >
            <MdDeleteForever size={22} aria-hidden="true" />
          </button>
        </div>
      ) : (
        <p className="text-xs text-tp-steel">
          {rejected
            ? 'That file isn’t a .zip package. Pick a .bim.zip.'
            : 'A .bim.zip with instance.json at its root.'}
        </p>
      )}
    </div>
  );
}

const textareaClass =
  'w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink focus:border-tp-primary focus:outline-none';

type Props =
  | {
      mode: 'problem';
      org: ProblemOrg;
      onClose: () => void;
      onCreated: (created: ProblemUpload) => void;
    }
  | {
      mode: 'version';
      org: ProblemOrg;
      item: Problem;
      onClose: () => void;
      onSaved: (saved: ProblemUpload) => void;
    };

/**
 * Upload a BIM package: as a new problem of the organization, or as the next version of a problem. The same package again is
 * not a new version: the gateway answers with the version it already is (`created: false`), and the caller says so.
 */
export default function ProblemImportModal(props: Props) {
  const { org, onClose } = props;
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const shownName = name || (file ? nameOfFile(file) : '');
  const slug = address ?? slugFromName(shownName);
  const slugOk = slug === '' || SLUG_PATTERN.test(slug);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!file) {
      setRefusal({ kind: 'invalid', text: 'Choose the .bim.zip package to upload.' });
      return;
    }
    if (props.mode === 'problem' && !slugOk) {
      setRefusal({
        kind: 'invalid',
        text: 'The address can only have lowercase letters, numbers and hyphens.',
      });
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      if (props.mode === 'problem')
        props.onCreated(
          await problemsApi.create(org.slug, file, {
            slug: slug || undefined,
            name: shownName.trim() || undefined,
            description: description.trim() || undefined,
            producer: UPLOAD_PRODUCER,
          })
        );
      else
        props.onSaved(
          await problemsApi.createRevision(org.slug, props.item.slug, file, {
            producer: UPLOAD_PRODUCER,
          })
        );
    } catch (caught) {
      setRefusal(uploadRefusal(caught, props.mode));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={
        props.mode === 'problem' ? 'Upload a BIM package' : `New version of ${props.item.name}`
      }
      size="md"
      onClose={() => !busy && onClose()}
    >
      <form className="flex flex-col gap-4" onSubmit={event => void submit(event)} noValidate>
        <p className="text-sm text-tp-steel">
          {props.mode === 'problem' ? (
            <>
              The package becomes a problem of{' '}
              <span className="font-medium text-tp-ink">{org.name}</span>, with this package as its
              first version.
            </>
          ) : (
            'The package is sealed as the next version. Uploading a package that already is a version of this problem changes nothing.'
          )}
        </p>
        <PackageDrop
          file={file}
          disabled={busy}
          onPick={picked => {
            setFile(picked);
            setRefusal(null);
          }}
        />
        {props.mode === 'problem' && (
          <>
            <FormField
              label="Name"
              value={shownName}
              maxLength={NAME_MAX}
              hint="Taken from the file name unless you write one."
              onChange={event => {
                setName(event.target.value);
                setRefusal(null);
              }}
            />
            <FormField
              label="Address"
              value={slug}
              onChange={event => {
                setAddress(event.target.value);
                setRefusal(null);
              }}
              spellCheck={false}
              mono
              error={!slugOk ? 'Lowercase letters, numbers and hyphens.' : undefined}
              hint="Used in the address; can’t be changed later. Left empty, the package’s name is used."
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="problem-description" className="text-sm font-medium text-tp-ink">
                Description <span className="font-normal text-tp-steel">(optional)</span>
              </label>
              <textarea
                id="problem-description"
                className={textareaClass}
                rows={3}
                maxLength={DESCRIPTION_MAX}
                value={description}
                onChange={event => setDescription(event.target.value)}
              />
            </div>
          </>
        )}
        <div aria-live="assertive">{refusal && <RefusalText refusal={refusal} />}</div>
        <div className="flex justify-end gap-2">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="primary" busy={busy}>
            {props.mode === 'problem' ? 'Upload problem' : 'Upload version'}
          </Action>
        </div>
      </form>
    </Modal>
  );
}
