import type { BimResourceRef, EngineRegistrationManifest } from '../../api/client';
import { isRecord } from '../Engines/registrationModel';
import { NAME_PATTERN, SEMVER_PATTERN, type Issue } from './engineDraft';

export type AuthScheme = 'none' | 'bearer' | 'basic';

export interface DeploymentDraft {
  /** The registration’s own name and version; they default to the engine’s. */
  name: string;
  version: string;
  endpoint: string;
  request: string;
  health: string;
  openapi: string;
  job: string;
  auth: AuthScheme;
  /** The deployment’s OpenAPI 3.1 document, as text. */
  contract: string;
  /** The file it was read from, if it came from one. */
  fileName: string;
}

export const MAPPING_FIELDS = [
  { id: 'request', label: 'Solve', required: true, help: 'Where we send problems (POST).' },
  { id: 'health', label: 'Health', required: true, help: 'Must answer when it’s up (GET).' },
  { id: 'openapi', label: 'Contract', required: true, help: 'Where it serves its OpenAPI; checked at every verification.' },
  { id: 'job', label: 'Job status', required: false, help: 'For long runs: a path with {id}, only if solving answers 202.' },
] as const;

export function newDeployment(): DeploymentDraft {
  return {
    name: '', version: '', endpoint: '', request: '/internal/v1/binding-problems', health: '/health', openapi: '/openapi.json', job: '', auth: 'none', contract: '', fileName: '',
  };
}

const SECRET_LOOKING = /token=|key=|secret|password|@/i;
const PATH_PATTERN = /^\/\S*$/;

/** What is wrong with an endpoint address, if anything. Secrets belong to the credential step, never to an address. */
export function endpointProblem(endpoint: string): string | null {
  const text = endpoint.trim();
  if (text === '') return 'Enter the address of your deployment.';
  if (!/^https?:\/\/[^\s/?#]+/i.test(text)) return 'Use a full https:// address.';
  if (SECRET_LOOKING.test(text)) return 'This looks like it contains a secret. Remove it.';
  return null;
}

export function pathProblem(path: string, required: boolean): string | null {
  if (path === '') return required ? 'Required.' : null;
  return PATH_PATTERN.test(path) ? null : 'Start with / and use no spaces.';
}

// -- The pinned contract ---------------------------------------------------------------------------------

export interface ContractCheck {
  id: 'version' | 'info' | 'paths' | 'protocol' | 'fingerprint';
  label: string;
  value: string;
  ok: boolean;
}

export interface ContractReading {
  state: 'empty' | 'invalid' | 'read';
  message: string | null;
  document: Record<string, unknown> | null;
  checks: ContractCheck[];
  ok: boolean;
}

/** Read an OpenAPI document and say, check by check, whether it can be pinned to a registration. */
export function analyzeContract(text: string, mapped: string[], protocolDigest: string | null): ContractReading {
  if (text.trim() === '') return { state: 'empty', message: null, document: null, checks: [], ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'invalid', message: 'The deployment OpenAPI document must be valid JSON.', document: null, checks: [], ok: false };
  }
  if (!isRecord(parsed)) {
    return { state: 'invalid', message: 'The deployment OpenAPI document must be a JSON object.', document: null, checks: [], ok: false };
  }
  const info = isRecord(parsed.info) ? parsed.info : null;
  const paths = isRecord(parsed.paths) ? parsed.paths : null;
  const pathCount = paths ? Object.keys(paths).length : 0;
  const mappedFound = paths ? mapped.filter((path) => path in paths).length : 0;
  const titled = typeof info?.title === 'string' && typeof info.version === 'string';
  const declared = parsed['x-bim-protocol'];
  const pinned = parsed['x-bim-protocol-digest'];
  const checks: ContractCheck[] = [
    { id: 'version', label: 'OpenAPI version', value: typeof parsed.openapi === 'string' ? parsed.openapi : 'Not declared', ok: parsed.openapi === '3.1.0' },
    { id: 'info', label: 'Title and version', value: titled ? `${info?.title as string} ${info?.version as string}` : 'Missing info.title or info.version', ok: titled },
    {
      id: 'paths',
      label: 'Paths',
      value: pathCount > 0 ? `${pathCount} path${pathCount === 1 ? '' : 's'}, including ${mappedFound} of the ${mapped.length} mapped` : 'None described',
      ok: pathCount > 0,
    },
    { id: 'protocol', label: 'Protocol', value: typeof declared === 'string' ? declared : 'Not declared', ok: declared === 'bim-engine/v1' },
    {
      id: 'fingerprint',
      label: 'Protocol fingerprint',
      value: protocolDigest === null ? 'Can’t compare: the gateway’s fingerprint isn’t available' : pinned === protocolDigest ? 'Matches' : typeof pinned === 'string' ? 'Different from bim-engine/v1’s' : 'Not pinned',
      ok: protocolDigest !== null && pinned === protocolDigest,
    },
  ];
  return { state: 'read', message: null, document: parsed, checks, ok: checks.every((check) => check.ok) };
}

// -- Validation and the registration document ---------------------------------------------------------------

export function validateDeployment(draft: DeploymentDraft, reading: ContractReading): Issue[] {
  const issues: Issue[] = [];
  const endpoint = endpointProblem(draft.endpoint);
  if (endpoint) issues.push({ path: 'endpoint', message: endpoint });
  for (const field of MAPPING_FIELDS) {
    const problem = pathProblem(draft[field.id], field.required);
    if (problem) issues.push({ path: field.id, message: problem });
  }
  if (draft.name.trim() !== '' && !NAME_PATTERN.test(draft.name.trim())) issues.push({ path: 'name', message: 'Start with a letter or digit; then letters, digits, . _ - only.' });
  if (draft.version.trim() !== '' && !SEMVER_PATTERN.test(draft.version.trim())) issues.push({ path: 'version', message: 'Use three numbers like 1.0.0, starting at 1.' });
  if (reading.state === 'empty') issues.push({ path: 'contract', message: 'Add the deployment’s OpenAPI file to continue.' });
  else if (reading.state === 'invalid') issues.push({ path: 'contract', message: reading.message ?? 'The contract could not be read.' });
  else if (!reading.ok) issues.push({ path: 'contract', message: 'The contract doesn’t pass every check.' });
  return issues;
}

export function buildRegistration(
  draft: DeploymentDraft,
  engine: BimResourceRef,
  namespace: string,
  protocol: { id: string; digest: string },
  openapi: Record<string, unknown>,
): EngineRegistrationManifest {
  return {
    apiVersion: 'bim/v1',
    kind: 'EngineRegistration',
    metadata: {
      namespace,
      name: draft.name.trim() || `${engine.name}-deployment`,
      version: draft.version.trim() || engine.version,
    },
    spec: {
      engine: { namespace: engine.namespace, name: engine.name, version: engine.version, digest: engine.digest },
      endpoint: draft.endpoint.trim(),
      protocol: { id: protocol.id as 'bim-engine/v1', mediaType: 'application/json', digest: protocol.digest },
      mappings: {
        request: draft.request.trim(),
        health: draft.health.trim(),
        openapi: draft.openapi.trim(),
        ...(draft.job.trim() ? { job: draft.job.trim() } : {}),
      },
      auth: { scheme: draft.auth },
      openapi,
    },
  };
}

/** The form’s deployment fields read back from a registration manifest, to register the deployment again under a new version. */
export function deploymentFromManifest(manifest: unknown, openapi: unknown): DeploymentDraft {
  const draft = newDeployment();
  const spec = isRecord(manifest) && isRecord(manifest.spec) ? manifest.spec : {};
  const mappings = isRecord(spec.mappings) ? spec.mappings : {};
  const scheme = isRecord(spec.auth) ? spec.auth.scheme : undefined;
  const pick = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
  return {
    ...draft,
    endpoint: pick(spec.endpoint, ''),
    request: pick(mappings.request, draft.request),
    health: pick(mappings.health, draft.health),
    openapi: pick(mappings.openapi, draft.openapi),
    job: pick(mappings.job, ''),
    auth: scheme === 'bearer' || scheme === 'basic' ? scheme : 'none',
    contract: isRecord(openapi) ? JSON.stringify(openapi, null, 2) : '',
  };
}
