import { useId, useState, type ChangeEvent, type DragEvent } from 'react';
import { MdCheck, MdClose, MdWarningAmber } from 'react-icons/md';
import { FormField } from '../../../core/components/form-field';
import { issueAt, type Issue } from '../engine-form/engineDraft';
import {
  BLOCK,
  FIELD_ERROR,
  FIELD_LABEL,
  GRID,
  INPUT,
  MORE,
  MORE_SUMMARY,
  MUTED,
  STACKED,
} from '../engine-parts/styles';
import {
  MAPPING_FIELDS,
  endpointProblem,
  type AuthScheme,
  type ContractReading,
  type DeploymentDraft,
} from './deploymentDraft';

const FILE_BUTTON =
  'relative inline-flex min-h-9 cursor-pointer items-center self-start rounded-md border border-tp-hairline-strong bg-tp-canvas px-3.5 text-[13px] font-medium text-tp-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tp-primary hover:bg-tp-surface';
const FILE_INPUT = 'absolute inset-0 cursor-pointer opacity-0';
const TEXTAREA = `${INPUT} min-h-30 resize-y py-2 font-mono text-xs`;

const AUTHS: ReadonlyArray<{ id: AuthScheme; label: string; help: string }> = [
  { id: 'none', label: 'None', help: 'Open endpoint (for example inside your network).' },
  { id: 'bearer', label: 'Bearer token', help: 'We send a token you give us in the next step.' },
  {
    id: 'basic',
    label: 'Username and password',
    help: 'Basic sign-in; you give both in the next step.',
  },
];

interface DeploymentFormProps {
  draft: DeploymentDraft;
  onChange: (draft: DeploymentDraft) => void;
  reading: ContractReading;
  issues: Issue[];
  locked: boolean;
}

/** Step 2: where the deployment is and the contract it follows. Nothing on this step may carry a secret. */
export function DeploymentForm({ draft, onChange, reading, issues, locked }: DeploymentFormProps) {
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const editorId = useId();
  const patch = (next: Partial<DeploymentDraft>) => onChange({ ...draft, ...next });
  const endpointIssue =
    draft.endpoint === '' ? undefined : (endpointProblem(draft.endpoint) ?? undefined);
  const plainHttp = /^http:\/\//i.test(draft.endpoint.trim());

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      patch({ contract: await file.text(), fileName: file.name });
      setFileError(null);
    } catch {
      setFileError('The OpenAPI file could not be read.');
    }
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    void readFile(event.target.files?.[0]);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!locked) void readFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div
        role="note"
        className="flex gap-2.5 rounded-lg border border-tp-severity-warning-border bg-tp-severity-warning-bg px-3 py-2.5 text-[13px] text-tp-ink"
      >
        <MdWarningAmber
          className="h-4.5 w-4.5 flex-none text-tp-severity-warning"
          aria-hidden="true"
        />
        <span>
          Nothing on this step may contain a secret. Tokens or passwords inside the address or the
          contract are refused; they go in the next step.
        </span>
      </div>

      <FormField
        label="Endpoint address"
        mono
        type="url"
        value={draft.endpoint}
        disabled={locked}
        autoComplete="off"
        spellCheck={false}
        placeholder="https://engine.example"
        error={endpointIssue}
        hint={
          plainHttp
            ? 'Plain http is accepted only in development; production requires https.'
            : 'HTTPS. OpenBinding calls it from its own servers, never from your browser, and blocks private-network destinations in production.'
        }
        onChange={event => patch({ endpoint: event.target.value })}
      />

      <div className={BLOCK}>
        <div className={FIELD_LABEL}>Paths on your deployment</div>
        <div className="grid [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
          {MAPPING_FIELDS.map(field => (
            <label key={field.id} className={STACKED}>
              <span className="flex items-baseline justify-between gap-2">
                <strong className="font-medium text-tp-ink">{field.label}</strong>
                <small className="font-normal text-tp-steel">
                  {field.required ? 'required' : 'optional'}
                </small>
              </span>
              <input
                aria-label={`${field.label} path`}
                className={`${INPUT} font-mono`}
                value={draft[field.id]}
                disabled={locked}
                spellCheck={false}
                placeholder={field.id === 'job' ? '/internal/v1/jobs/{id}' : undefined}
                aria-invalid={issueAt(issues, field.id) ? true : undefined}
                onChange={event => onChange({ ...draft, [field.id]: event.target.value })}
              />
              <small
                className={issueAt(issues, field.id) ? FIELD_ERROR : 'font-normal text-tp-steel'}
              >
                {issueAt(issues, field.id) ?? field.help}
              </small>
            </label>
          ))}
        </div>
      </div>

      <div className={BLOCK}>
        <div className={FIELD_LABEL}>How OpenBinding signs in to it</div>
        <div
          className="grid [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))] gap-2"
          role="radiogroup"
          aria-label="Authentication"
        >
          {AUTHS.map(auth => (
            <button
              key={auth.id}
              type="button"
              role="radio"
              aria-checked={draft.auth === auth.id}
              disabled={locked}
              onClick={() => patch({ auth: auth.id })}
              className="group flex cursor-pointer items-start gap-2.5 rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-70 aria-checked:border-2 aria-checked:border-tp-primary aria-checked:bg-tp-severity-info-bg"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 flex-none rounded-full border-2 border-tp-hairline-strong group-aria-checked:border-[5px] group-aria-checked:border-tp-primary"
              />
              <span className="flex flex-col gap-0.5">
                <strong className="text-[13px] font-semibold text-tp-ink">{auth.label}</strong>
                <small className="text-xs text-tp-slate">{auth.help}</small>
              </span>
            </button>
          ))}
        </div>
        <small className={MUTED}>
          The sign-in method must match the security of the solve, health and optional run
          operations in the contract.
        </small>
      </div>

      <div className={BLOCK}>
        <div className={FIELD_LABEL}>Pinned contract (OpenAPI)</div>
        <div
          className={`flex flex-col gap-2 rounded-xl border-2 border-dashed p-4 text-sm ${
            dragging
              ? 'border-tp-primary bg-tp-severity-info-bg'
              : 'border-tp-hairline-strong bg-tp-surface'
          }`}
          onDragOver={event => {
            event.preventDefault();
            if (!locked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <strong className="font-semibold text-tp-ink">
            {draft.fileName ? `Read ${draft.fileName}` : 'Drop your deployment’s OpenAPI file'}
          </strong>
          <span className="text-xs text-tp-slate">
            We pin this exact document, so later changes on your side are detected. It has to be the
            same document the deployment serves at its contract path.
          </span>
          <label className={FILE_BUTTON}>
            <span>{draft.contract ? 'Choose another file' : 'Choose file'}</span>
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Deployment OpenAPI file"
              className={FILE_INPUT}
              disabled={locked}
              onChange={onPick}
            />
          </label>
        </div>
        {fileError && (
          <span className={FIELD_ERROR} role="alert">
            {fileError}
          </span>
        )}

        <details className={MORE}>
          <summary className={MORE_SUMMARY}>Paste the JSON instead</summary>
          <label htmlFor={editorId} className={FIELD_LABEL}>
            Deployment OpenAPI JSON
          </label>
          <textarea
            id={editorId}
            className={TEXTAREA}
            name="deployment-openapi"
            rows={10}
            value={draft.contract}
            disabled={locked}
            spellCheck={false}
            placeholder={
              '{\n  "openapi": "3.1.0",\n  "info": { "title": "My engine", "version": "1.0.0" },\n  "x-bim-protocol": "bim-engine/v1",\n  "x-bim-protocol-digest": "…",\n  "paths": { … }\n}'
            }
            onChange={event => patch({ contract: event.target.value, fileName: '' })}
          />
        </details>

        {reading.state === 'invalid' && (
          <span className={FIELD_ERROR} role="alert">
            {reading.message}
          </span>
        )}
        {reading.state === 'read' && (
          <>
            <ul
              className="grid [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))] gap-2"
              aria-label="What we read from the contract"
            >
              {reading.checks.map(check => (
                <li
                  key={check.id}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                    check.ok
                      ? 'border-tp-severity-success-border bg-tp-severity-success-bg'
                      : 'border-tp-severity-error-border bg-tp-severity-error-bg'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={check.ok ? 'text-tp-success-text' : 'text-tp-error-text'}
                  >
                    {check.ok ? <MdCheck className="h-4 w-4" /> : <MdClose className="h-4 w-4" />}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <strong className="font-medium text-tp-ink">{check.label}</strong>
                    <small className="text-xs [overflow-wrap:anywhere] text-tp-slate">
                      {check.value}
                      <span className="sr-only">{check.ok ? ' (passes)' : ' (fails)'}</span>
                    </small>
                  </span>
                </li>
              ))}
            </ul>
            <small className={MUTED}>
              Read from the document you gave. Protocol: bim-engine/v1.
            </small>
          </>
        )}
      </div>

      <details className={MORE}>
        <summary className={MORE_SUMMARY}>
          Registration name and version{' '}
          <span className="ml-2 text-xs font-normal text-tp-steel">
            optional · default to the engine’s
          </span>
        </summary>
        <div className={GRID}>
          <FormField
            label="Registration name"
            mono
            value={draft.name}
            disabled={locked}
            spellCheck={false}
            placeholder="my-engine-deployment"
            error={issueAt(issues, 'name')}
            hint="Defaults to the engine name plus -deployment."
            onChange={event => patch({ name: event.target.value })}
          />
          <FormField
            label="Registration version"
            mono
            value={draft.version}
            disabled={locked}
            spellCheck={false}
            placeholder="1.0.0"
            error={issueAt(issues, 'version')}
            hint="Defaults to the engine version."
            onChange={event => patch({ version: event.target.value })}
          />
        </div>
      </details>
    </div>
  );
}
