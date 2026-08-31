import { useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type {
  EngineManifest,
  EngineRegistrationRevision,
  EngineRevision,
} from '../../api/client';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { useAuth } from '../../contexts/auth';
import './RegisterEngine.css';

type AuthScheme = 'none' | 'bearer' | 'basic';

/** Create a private Engine and, optionally, its equally private deployment. */
export function RegisterEngine() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [manifestText, setManifestText] = useState(() => engineTemplate(user?.username || 'your-namespace'));
  const [registerDeployment, setRegisterDeployment] = useState(true);
  const [registrationName, setRegistrationName] = useState('');
  const [registrationVersion, setRegistrationVersion] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [requestPath, setRequestPath] = useState('/internal/v1/binding-problems');
  const [healthPath, setHealthPath] = useState('/health');
  const [openapiPath, setOpenapiPath] = useState('/openapi.json');
  const [jobPath, setJobPath] = useState('');
  const [authScheme, setAuthScheme] = useState<AuthScheme>('none');
  const [credential, setCredential] = useState('');
  const [openapiText, setOpenapiText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    engine: EngineRevision;
    registration?: EngineRegistrationRevision;
  } | null>(null);

  const loadOpenApiFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setOpenapiText(await file.text());
      setError(null);
    } catch {
      setError('The OpenAPI file could not be read.');
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!user) throw new Error('Registering an Engine requires a signed-in account.');
      const authored = parseObject(manifestText, 'Engine manifest');
      const manifest = {
        ...(authored as unknown as EngineManifest),
        metadata: {
          ...(authored.metadata as EngineManifest['metadata']),
          namespace: user.username,
        },
      };
      let openapi: Record<string, unknown> | null = null;
      let profile: Awaited<ReturnType<typeof apiClient.getBimProfile>> | null = null;
      if (registerDeployment) {
        if (!endpoint.trim()) throw new Error('A deployment endpoint is required.');
        if (!requestPath.trim() || !healthPath.trim() || !openapiPath.trim()) {
          throw new Error('Solve, health and OpenAPI paths are required.');
        }
        if (authScheme !== 'none' && !credential) {
          throw new Error(`A ${authScheme} credential is required and will be stored separately.`);
        }
        openapi = parseObject(openapiText, 'Deployment OpenAPI document');
        if (openapi.openapi !== '3.1.0') {
          throw new Error('The deployment OpenAPI document must declare openapi: 3.1.0.');
        }
        const info = openapi.info;
        if (!info || typeof info !== 'object' || Array.isArray(info)
          || typeof (info as Record<string, unknown>).title !== 'string'
          || typeof (info as Record<string, unknown>).version !== 'string') {
          throw new Error('The deployment OpenAPI document needs info.title and info.version.');
        }
        const paths = openapi.paths;
        if (!paths || typeof paths !== 'object' || Array.isArray(paths) || Object.keys(paths).length === 0) {
          throw new Error('The deployment OpenAPI document must describe its mapped operations.');
        }
        profile = await apiClient.getBimProfile();
        if (openapi['x-bim-protocol'] !== profile.protocol) {
          throw new Error('The deployment OpenAPI document must declare x-bim-protocol: bim-engine/v1.');
        }
        if (openapi['x-bim-protocol-digest'] !== profile.protocolDigest) {
          throw new Error('The deployment OpenAPI document does not pin this gateway’s bim-engine/v1 digest.');
        }
      }

      // Do not persist the portable resource until every client-side deployment
      // check has passed. The API still validates both resources authoritatively.
      const engine = await apiClient.createEngine(manifest);
      if (!registerDeployment) {
        setResult({ engine });
        return;
      }
      if (!openapi || !profile) throw new Error('The deployment contract was not validated.');
      const registration = await apiClient.createEngineRegistration({
        apiVersion: 'bim/v1',
        kind: 'EngineRegistration',
        metadata: {
          namespace: user.username,
          name: registrationName.trim() || `${engine.name}-deployment`,
          version: registrationVersion.trim() || engine.version,
        },
        spec: {
          engine: {
            namespace: engine.namespace,
            name: engine.name,
            version: engine.version,
            digest: engine.digest,
          },
          endpoint: endpoint.trim(),
          protocol: {
            id: profile.protocol,
            mediaType: 'application/json',
            digest: profile.protocolDigest,
          },
          mappings: {
            request: requestPath.trim(),
            health: healthPath.trim(),
            openapi: openapiPath.trim(),
            ...(jobPath.trim() ? { job: jobPath.trim() } : {}),
          },
          auth: { scheme: authScheme },
          openapi,
        },
      });
      const stored = authScheme === 'none'
        ? registration
        : await apiClient.setEngineRegistrationCredential(registration, credential);
      setCredential('');
      setResult({ engine, registration: stored });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'The BIM v1 Engine or registration was refused.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="register-engine-page">
      <div className="container">
        <header className="page-header">
          <span className="register-engine-kicker">Private engine registration</span>
          <h1>Register an Engine</h1>
          <p className="page-description">
            Save an immutable <code>bim/v1</code> Engine and its deployment privately.
            Administrators cannot see either one until you explicitly request publication.
          </p>
        </header>

        {error && <Alert type="error" title="Registration refused">{error}</Alert>}

        {!result ? (
          <Card padding="lg" className="wizard-card">
            <h2>1. Engine manifest</h2>
            <p className="wizard-hint">
              Declare modes, Profile/IR support, capabilities, options, limits and real guarantees.
              {' '}The namespace is fixed to your account: <code>{user?.username}</code>.
            </p>
            <textarea
              className="manifest-editor"
              aria-label="Engine manifest JSON"
              name="engine-manifest"
              rows={24}
              value={manifestText}
              spellCheck={false}
              onChange={(event) => setManifestText(event.target.value)}
            />

            <label className="deployment-choice">
              <input
                type="checkbox"
                checked={registerDeployment}
                onChange={(event) => setRegisterDeployment(event.target.checked)}
              />
              <span><strong>Register a deployment now</strong><small>It starts private and inactive; activation performs a live conformance check.</small></span>
            </label>

            {registerDeployment && <div className="deployment-form">
              <header>
                <h2>2. Private deployment</h2>
                <p className="wizard-hint">The submitted OpenAPI document is immutable and must exactly match the document served by the endpoint.</p>
              </header>
              <div className="field-pair">
                <label className="field">
                  <span>Registration name</span>
                  <input value={registrationName} onChange={(event) => setRegistrationName(event.target.value)} placeholder="my-engine-deployment" />
                  <small>Defaults to the Engine name plus <code>-deployment</code>.</small>
                </label>
                <label className="field">
                  <span>Registration version</span>
                  <input value={registrationVersion} onChange={(event) => setRegistrationVersion(event.target.value)} placeholder="1.0.0" />
                  <small>Defaults to the Engine version.</small>
                </label>
              </div>
              <label className="field">
                <span>HTTPS endpoint</span>
                <input type="url" autoComplete="off" spellCheck={false} value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://engine.example" />
                <small>The gateway validates DNS and blocks private-network destinations in production.</small>
              </label>
              <div className="field-pair">
                <label className="field"><span>Solve path</span><input value={requestPath} onChange={(event) => setRequestPath(event.target.value)} /><small>Mapped <code>POST</code>.</small></label>
                <label className="field"><span>Health path</span><input value={healthPath} onChange={(event) => setHealthPath(event.target.value)} /><small>Mapped <code>GET</code>.</small></label>
                <label className="field"><span>OpenAPI path</span><input value={openapiPath} onChange={(event) => setOpenapiPath(event.target.value)} /><small>Document checked at every verification.</small></label>
                <label className="field"><span>Async job path</span><input value={jobPath} onChange={(event) => setJobPath(event.target.value)} placeholder="/internal/v1/jobs/{id}" /><small>Only for a solve operation returning <code>202</code>.</small></label>
              </div>
              <div className="field-pair">
                <label className="field">
                  <span>Authentication</span>
                  <select value={authScheme} onChange={(event) => setAuthScheme(event.target.value as AuthScheme)}>
                    <option value="none">none</option>
                    <option value="bearer">bearer</option>
                    <option value="basic">basic</option>
                  </select>
                  <small>Must match the solve, health and optional async-job operation security in OpenAPI.</small>
                </label>
                {authScheme !== 'none' && <label className="field">
                  <span>Credential</span>
                  <input type="password" autoComplete="off" value={credential} onChange={(event) => setCredential(event.target.value)} />
                  <small>{authScheme === 'basic' ? 'Use username:password. ' : 'Use the bearer token only. '}Encrypted separately; never inserted into or returned with the manifest.</small>
                </label>}
              </div>
              <label className="openapi-upload">
                <span>Deployment OpenAPI 3.1 JSON</span>
                <input type="file" accept="application/json,.json" onChange={(event) => void loadOpenApiFile(event)} />
                <small>Upload a JSON file or paste the same document served at the mapped OpenAPI path.</small>
              </label>
              <textarea
                className="manifest-editor openapi-editor"
                aria-label="Deployment OpenAPI JSON"
                name="deployment-openapi"
                rows={20}
                value={openapiText}
                spellCheck={false}
                placeholder={'{\n  "openapi": "3.1.0",\n  "info": { "title": "My engine", "version": "1.0.0" },\n  "x-bim-protocol": "bim-engine/v1",\n  "x-bim-protocol-digest": "sha256-…",\n  "paths": { … }\n}'}
                onChange={(event) => setOpenapiText(event.target.value)}
              />
            </div>}

            <div className="wizard-actions">
              <Button onClick={submit} disabled={busy}>
                {busy ? 'Saving privately…' : registerDeployment ? 'Save private Engine and deployment' : 'Save private Engine'}
              </Button>
              <Button variant="ghost" onClick={() => navigate('/engines', { viewTransition: true })} disabled={busy}>Cancel</Button>
            </div>
          </Card>
        ) : (
          <Card padding="lg" className="wizard-card">
            <div className="result-header">
              <h2>{result.engine.namespace}/{result.engine.name}</h2>
              <Badge variant={result.engine.status === 'published' ? 'success' : 'info'}>{result.engine.status}</Badge>
            </div>
            <p className="engine-id-line"><code>{result.engine.version}</code> · <code>{result.engine.digest}</code></p>
            <Alert type="success" title="Private Engine revision saved">
              Only your account can discover it. A material change requires a new version and digest.
            </Alert>
            {result.registration && <div className="registration-result">
              <h3>EngineRegistration</h3>
              <p><code>{result.registration.namespace}/{result.registration.name}</code> · <code>{result.registration.version}</code></p>
              <p><code>{result.registration.digest}</code></p>
              <div className="registration-result-state">
                <Badge variant="info">{result.registration.status.replace('_', ' ')}</Badge>
                <Badge variant={result.registration.active ? 'success' : 'default'}>{result.registration.active ? 'active for you' : 'inactive'}</Badge>
              </div>
              <p>Activate it from My deployments. Administrators will only see it after you request publication.</p>
            </div>}
            <div className="wizard-actions">
              <Button onClick={() => navigate('/engines', { viewTransition: true })}>Manage deployments</Button>
              <Button variant="secondary" onClick={() => setResult(null)}>Register another revision</Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function parseObject(source: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function engineTemplate(namespace: string): string {
  return `{
  "apiVersion": "bim/v1",
  "kind": "Engine",
  "metadata": { "namespace": ${JSON.stringify(namespace)}, "name": "my-engine", "version": "1.0.0", "description": "My QoS engine" },
  "spec": {
    "modes": [{
      "id": "default",
      "profile": "qos-binding/v1",
      "ir": { "apiVersion": "bim/v1", "kind": "BindingProblem" },
      "algorithm": "deterministic-search",
      "capabilities": {
        "workflowNodes": { "selector": "all" },
        "metricScopes": { "selector": "all" },
        "aggregations": { "selector": "all" },
        "constraints": { "selector": "all" },
        "optimization": { "selector": "all" },
        "objectiveTypes": { "selector": "all" },
        "expressions": { "selector": "all" },
        "placement": { "selector": "none" },
        "irExtensions": { "selector": "none" }
      },
      "optionsSchema": { "type": "object", "properties": {}, "additionalProperties": false },
      "limits": { "maxIterations": 100000 },
      "guarantees": {
        "termination": ["FEASIBLE", "UNKNOWN"],
        "exact": false,
        "deterministicWithoutTimeBudget": true
      }
    }]
  }
}`;
}
