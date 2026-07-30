import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { ManifestDraft, RegisteredEngine } from '../../api/client';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import './RegisterEngine.css';

/**
 * Registering your own solver, in three steps that each do one thing.
 *
 * The order is deliberate. Reading the spec comes first because everything
 * after it is a correction rather than an authoring task: by the time anyone
 * sees the manifest, the gateway has already worked out which operation solves,
 * where the instance goes and which field is the binding. Then the manifest is
 * shown as text, because the person submitting it has to be able to see the
 * whole thing before it becomes an engine other people might use.
 *
 * The last step is not "success". It is the conformance report - what was
 * checked, what failed, and which field to change - because a registration that
 * fails is the common case on the first attempt and the interface should be
 * built around that rather than around the happy path.
 */

type Step = 'read' | 'correct' | 'result';

export function RegisterEngine() {
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [sourceKind, setSourceKind] = useState<'url' | 'document'>('url');
  const [openapiUrl, setOpenapiUrl] = useState('');
  const [openapiDocument, setOpenapiDocument] = useState('');
  const [engineId, setEngineId] = useState('');
  const [displayName, setDisplayName] = useState('');

  // Step 2
  const [draft, setDraft] = useState<ManifestDraft | null>(null);
  const [manifestText, setManifestText] = useState('');
  const [credential, setCredential] = useState('');
  const [askToPublish, setAskToPublish] = useState(false);

  // Step 3
  const [registered, setRegistered] = useState<RegisteredEngine | null>(null);

  const readSpec = async () => {
    setBusy(true);
    setError(null);
    try {
      const source: Parameters<typeof apiClient.draftEngineManifest>[0] = {
        engine_id: engineId || 'my-engine',
      };
      if (displayName) source.display_name = displayName;

      if (sourceKind === 'url') {
        source.openapi_url = openapiUrl.trim();
      } else {
        try {
          source.openapi_document = JSON.parse(openapiDocument);
        } catch {
          throw new Error('That is not valid JSON. Paste the document itself, or use a URL.');
        }
      }

      const proposal = await apiClient.draftEngineManifest(source);
      setDraft(proposal);
      setManifestText(JSON.stringify(proposal.manifest, null, 2));
      setStep('correct');
    } catch (err: any) {
      setError(err.message || 'The document could not be read.');
    } finally {
      setBusy(false);
    }
  };

  const skipToManual = () => {
    // Somebody who already has a manifest should not have to own an OpenAPI
    // URL to paste it in.
    setDraft({ manifest: {}, notes: [], unresolved: [], ready: false });
    setManifestText(EMPTY_MANIFEST);
    setStep('correct');
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      let manifest: Record<string, any>;
      try {
        manifest = JSON.parse(manifestText);
      } catch {
        throw new Error('The manifest is not valid JSON.');
      }

      const result = await apiClient.registerEngine({
        manifest,
        credential: credential.trim() || undefined,
        publish: askToPublish,
      });
      setRegistered(result);
      setStep('result');
    } catch (err: any) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyAgain = async () => {
    if (!registered) return;
    setBusy(true);
    try {
      setRegistered(await apiClient.verifyRegisteredEngine(registered.engine_id));
    } catch (err: any) {
      setError(err.message || 'The check could not be run.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="register-engine-page">
      <div className="container">
        <div className="page-header">
          <h1>Register an engine</h1>
          <p className="page-description">
            Point OpenBinding at a solver you run. It stays yours: the gateway validates
            instances against what you declare, sends them to your endpoint, and scores the
            answers with the same evaluator it uses for its own engines.
          </p>
        </div>

        <ol className="wizard-steps">
          <li className={step === 'read' ? 'current' : 'done'}>1. Read your spec</li>
          <li className={step === 'correct' ? 'current' : step === 'result' ? 'done' : ''}>
            2. Check the manifest
          </li>
          <li className={step === 'result' ? 'current' : ''}>3. Conformance</li>
        </ol>

        {error && (
          <Alert type="error" title="That did not work">
            {error}
          </Alert>
        )}

        {step === 'read' && (
          <Card padding="lg" className="wizard-card">
            <h2>Where is your engine described?</h2>
            <p className="wizard-hint">
              The gateway reads your OpenAPI document and works out the manifest: which
              operation solves, where the instance belongs in your request body, and which
              field of a solution is the task-to-candidate map. You correct what it got
              wrong rather than writing it from nothing.
            </p>

            <div className="source-toggle">
              <Button
                variant={sourceKind === 'url' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setSourceKind('url')}
              >
                By URL
              </Button>
              <Button
                variant={sourceKind === 'document' ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setSourceKind('document')}
              >
                Paste the document
              </Button>
            </div>

            {sourceKind === 'url' ? (
              <label className="field">
                <span>OpenAPI document URL</span>
                <input
                  type="url"
                  value={openapiUrl}
                  onChange={(e) => setOpenapiUrl(e.target.value)}
                  placeholder="https://acme.example/openapi.json"
                />
                <small>
                  Must be reachable on the public internet. The gateway refuses private and
                  loopback addresses, here and on every solve.
                </small>
              </label>
            ) : (
              <label className="field">
                <span>OpenAPI document (JSON)</span>
                <textarea
                  rows={10}
                  value={openapiDocument}
                  onChange={(e) => setOpenapiDocument(e.target.value)}
                  placeholder='{ "openapi": "3.1.0", "paths": { ... } }'
                />
                <small>For an engine that does not serve its spec anonymously.</small>
              </label>
            )}

            <div className="field-row">
              <label className="field">
                <span>Engine id</span>
                <input
                  value={engineId}
                  onChange={(e) => setEngineId(e.target.value)}
                  placeholder="tabu"
                />
                <small>Lower case, digits and hyphens. Yours is prefixed with your username.</small>
              </label>
              <label className="field">
                <span>Display name (optional)</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="ACME Tabu Search"
                />
              </label>
            </div>

            <div className="wizard-actions">
              <Button
                onClick={readSpec}
                disabled={busy || (sourceKind === 'url' ? !openapiUrl.trim() : !openapiDocument.trim())}
              >
                {busy ? 'Reading…' : 'Read the spec'}
              </Button>
              <Button variant="ghost" onClick={skipToManual} disabled={busy}>
                I already have a manifest
              </Button>
            </div>
          </Card>
        )}

        {step === 'correct' && draft && (
          <>
            {draft.notes.length > 0 && (
              <Card padding="lg" className="wizard-card">
                <h2>What the gateway worked out</h2>
                <p className="wizard-hint">
                  Each of these is a guess based on your document. Check them - a wrong one
                  costs a correction here, and a debugging session later.
                </p>
                <ul className="notes-list">
                  {draft.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </Card>
            )}

            {draft.unresolved.length > 0 && (
              <Alert
                type={draft.ready ? 'info' : 'warning'}
                title={draft.ready ? 'Worth deciding' : 'Needs your answer'}
              >
                <ul className="unresolved-list">
                  {draft.unresolved.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </Alert>
            )}

            <Card padding="lg" className="wizard-card">
              <h2>The manifest</h2>
              <p className="wizard-hint">
                Everything the gateway will believe about your engine.{' '}
                <a href="https://github.com/javiercavlop/OpenBinding/blob/main/docs/ENGINE_MANIFEST.md" target="_blank" rel="noreferrer">
                  Field-by-field reference
                </a>
                .
              </p>
              <textarea
                className="manifest-editor"
                rows={22}
                value={manifestText}
                spellCheck={false}
                onChange={(e) => setManifestText(e.target.value)}
              />

              <label className="field">
                <span>Credential (optional)</span>
                <input
                  type="password"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  placeholder="Only if your engine authenticates"
                />
                <small>
                  Stored encrypted and never returned by any endpoint - replaceable, not
                  readable. Leave empty for an open engine.
                </small>
              </label>

              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={askToPublish}
                  onChange={(e) => setAskToPublish(e.target.checked)}
                />
                <span>
                  Ask for this engine to be listed publicly. An administrator decides; until
                  then only you can see it.
                </span>
              </label>

              <div className="wizard-actions">
                <Button onClick={submit} disabled={busy}>
                  {busy ? 'Checking your engine…' : 'Register and verify'}
                </Button>
                <Button variant="ghost" onClick={() => setStep('read')} disabled={busy}>
                  Back
                </Button>
              </div>
            </Card>
          </>
        )}

        {step === 'result' && registered && (
          <Card padding="lg" className="wizard-card">
            <div className="result-header">
              <h2>{registered.display_name}</h2>
              <Badge variant={registered.status === 'active' ? 'success' : 'error'}>
                {registered.status}
              </Badge>
            </div>
            <p className="engine-id-line">
              <code>{registered.engine_id}</code>
            </p>

            {registered.status === 'active' ? (
              <Alert type="success" title="It works">
                Your engine answered the conformance instance with a legal binding. It is
                now selectable in the Playground and through <code>POST /v1/solve</code>.
              </Alert>
            ) : (
              <Alert type="warning" title="Not usable yet">
                The registration is saved. Fix what is listed below and check again - nothing
                is lost in the meantime.
              </Alert>
            )}

            {registered.conformance_report?.findings?.length ? (
              <div className="findings">
                <h3>What went wrong</h3>
                {registered.conformance_report.findings.map((finding, i) => (
                  <div key={i} className="finding">
                    <div className="finding-head">
                      <Badge variant="error">{finding.code}</Badge>
                      {finding.field && <code>{finding.field}</code>}
                    </div>
                    <p>{finding.message}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {registered.conformance_report?.steps?.length ? (
              <details className="steps">
                <summary>What was checked</summary>
                <ul>
                  {registered.conformance_report.steps.map((entry, i) => (
                    <li key={i}>{entry}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="wizard-actions">
              <Button onClick={verifyAgain} disabled={busy}>
                {busy ? 'Checking…' : 'Check again'}
              </Button>
              <Button variant="secondary" onClick={() => setStep('correct')} disabled={busy}>
                Edit the manifest
              </Button>
              <Button variant="ghost" onClick={() => navigate('/engines')}>
                Done
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

const EMPTY_MANIFEST = `{
  "manifest_version": "1",
  "engine_id": "my-engine",
  "display_name": "My Engine",
  "type": "HEURISTIC",
  "capabilities": {
    "qos_features_supported": ["*"],
    "composition_nodes_supported": ["TASK", "SEQ"],
    "objective_types_supported": ["MONO"],
    "constraints_supported": []
  },
  "instance_schema": { "type": "object" },
  "options_schema": { "type": "object", "additionalProperties": true },
  "transport": {
    "openapi": { "url": "https://acme.example/openapi.json" },
    "operations": { "solve": { "operationId": "REPLACE_ME" } },
    "request_mapping": { "instance": "/instance", "options": "/options" },
    "response_mapping": { "solutions": "/solutions", "binding": "/binding" }
  }
}`;

/** A validation failure names every field; anything else has one message. */
function describe(error: any): string {
  const violations = error?.detail?.violations ?? error?.violations;
  if (Array.isArray(violations) && violations.length) {
    return violations.map((v: any) => `${v.path}: ${v.message}`).join('\n');
  }
  return error?.message || 'The registration was refused.';
}
