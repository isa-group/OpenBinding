import { useId, useState, type ChangeEvent, type DragEvent } from 'react';
import { AlertTriangle, Check, X } from 'lucide-react';
import { FormField } from '../../components/ui/FormField';
import { shortDigest } from '../../utils/digest';
import { issueAt, type Issue } from './engineDraft';
import {
  MAPPING_FIELDS, endpointProblem,
  type AuthScheme, type ContractReading, type DeploymentDraft,
} from './deploymentDraft';

const AUTHS: ReadonlyArray<{ id: AuthScheme; label: string; help: string }> = [
  { id: 'none', label: 'None', help: 'Open endpoint (for example inside your network).' },
  { id: 'bearer', label: 'Bearer token', help: 'We send a token you give us in the next step.' },
  { id: 'basic', label: 'Username and password', help: 'Basic sign-in; you give both in the next step.' },
];

interface DeploymentFormProps {
  draft: DeploymentDraft;
  onChange: (draft: DeploymentDraft) => void;
  reading: ContractReading;
  issues: Issue[];
  locked: boolean;
  /** The bim-engine/v1 fingerprint the gateway publishes, if it could be read. */
  protocolDigest: string | null;
}

/** Step 2: where the deployment is and the contract it follows. Nothing on this step may carry a secret. */
export function DeploymentForm({ draft, onChange, reading, issues, locked, protocolDigest }: DeploymentFormProps) {
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const editorId = useId();
  const patch = (next: Partial<DeploymentDraft>) => onChange({ ...draft, ...next });
  const endpointIssue = draft.endpoint === '' ? undefined : endpointProblem(draft.endpoint) ?? undefined;
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
    <div className="rg-form">
      <div role="note" className="rg-warning">
        <AlertTriangle aria-hidden="true" />
        <span>Nothing on this step may contain a secret. Tokens or passwords inside the address or the contract are refused; they go in the next step.</span>
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
        hint={plainHttp ? 'Plain http is accepted only in development; production requires https.' : 'HTTPS. OpenBinding calls it from its own servers, never from your browser, and blocks private-network destinations in production.'}
        onChange={(event) => patch({ endpoint: event.target.value })}
      />

      <div className="rg-block">
        <div className="rg-field-label">Paths on your deployment</div>
        <div className="rg-paths">
          {MAPPING_FIELDS.map((field) => (
            <label key={field.id} className="rg-path">
              <span className="rg-path-head"><strong>{field.label}</strong><small>{field.required ? 'required' : 'optional'}</small></span>
              <input
                aria-label={`${field.label} path`}
                className="is-mono"
                value={draft[field.id]}
                disabled={locked}
                spellCheck={false}
                placeholder={field.id === 'job' ? '/internal/v1/jobs/{id}' : undefined}
                aria-invalid={issueAt(issues, field.id) ? true : undefined}
                onChange={(event) => onChange({ ...draft, [field.id]: event.target.value })}
              />
              <small className={issueAt(issues, field.id) ? 'rg-error' : undefined}>{issueAt(issues, field.id) ?? field.help}</small>
            </label>
          ))}
        </div>
      </div>

      <div className="rg-block">
        <div className="rg-field-label">How OpenBinding signs in to it</div>
        <div className="rg-auths" role="radiogroup" aria-label="Authentication">
          {AUTHS.map((auth) => (
            <button key={auth.id} type="button" role="radio" aria-checked={draft.auth === auth.id} disabled={locked} onClick={() => patch({ auth: auth.id })}>
              <span aria-hidden="true" className="rg-radio" />
              <span><strong>{auth.label}</strong><small>{auth.help}</small></span>
            </button>
          ))}
        </div>
        <small className="eng-muted">The sign-in method must match the security of the solve, health and optional job operations in the contract.</small>
      </div>

      <div className="rg-block">
        <div className="rg-field-label">Pinned contract (OpenAPI)</div>
        <div
          className={`rg-drop${dragging ? ' is-over' : ''}`}
          onDragOver={(event) => { event.preventDefault(); if (!locked) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <strong>{draft.fileName ? `Read ${draft.fileName}` : 'Drop your deployment’s OpenAPI file'}</strong>
          <span>We pin it by fingerprint, so later changes on your side are detected. It has to be the same document the deployment serves at its contract path.</span>
          <label className="rg-file">
            <span>{draft.contract ? 'Choose another file' : 'Choose file'}</span>
            <input type="file" accept="application/json,.json" aria-label="Deployment OpenAPI file" disabled={locked} onChange={onPick} />
          </label>
        </div>
        {fileError && <span className="rg-error" role="alert">{fileError}</span>}

        <details className="rg-paste">
          <summary>Paste the JSON instead</summary>
          <label htmlFor={editorId}>Deployment OpenAPI JSON</label>
          <textarea
            id={editorId}
            name="deployment-openapi"
            rows={10}
            value={draft.contract}
            disabled={locked}
            spellCheck={false}
            placeholder={'{\n  "openapi": "3.1.0",\n  "info": { "title": "My engine", "version": "1.0.0" },\n  "x-bim-protocol": "bim-engine/v1",\n  "x-bim-protocol-digest": "sha256-…",\n  "paths": { … }\n}'}
            onChange={(event) => patch({ contract: event.target.value, fileName: '' })}
          />
        </details>

        {reading.state === 'invalid' && <span className="rg-error" role="alert">{reading.message}</span>}
        {reading.state === 'read' && (
          <>
            <ul className="rg-spec" aria-label="What we read from the contract">
              {reading.checks.map((check) => (
                <li key={check.id} className={check.ok ? 'is-ok' : 'is-bad'}>
                  <span aria-hidden="true">{check.ok ? <Check /> : <X />}</span>
                  <span><strong>{check.label}</strong><small>{check.value}<span className="sr-only">{check.ok ? ' (passes)' : ' (fails)'}</span></small></span>
                </li>
              ))}
            </ul>
            <small className="eng-muted">
              Read from the document you gave. Protocol: bim-engine/v1{protocolDigest ? ` · fingerprint ${shortDigest(protocolDigest)}` : ''}.
            </small>
          </>
        )}
      </div>

      <details className="rg-more">
        <summary>Registration name and version <span>optional · default to the engine’s</span></summary>
        <div className="rg-grid">
          <FormField label="Registration name" mono value={draft.name} disabled={locked} spellCheck={false} placeholder="my-engine-deployment" error={issueAt(issues, 'name')} hint="Defaults to the engine name plus -deployment." onChange={(event) => patch({ name: event.target.value })} />
          <FormField label="Registration version" mono value={draft.version} disabled={locked} spellCheck={false} placeholder="1.0.0" error={issueAt(issues, 'version')} hint="Defaults to the engine version." onChange={(event) => patch({ version: event.target.value })} />
        </div>
      </details>
    </div>
  );
}
