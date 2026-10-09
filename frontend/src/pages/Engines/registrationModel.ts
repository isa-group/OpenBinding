import { bimResourceKey, HttpError } from '../../api/client';
import type { BimResourceRef, EngineRegistrationRevision, EngineRegistrationState } from '../../api/client';
import { QuotaError } from '../../api/auth';
import type { UsageView } from '../../api/auth';

export type ChipTone = 'plain' | 'info' | 'success' | 'warning' | 'error';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { bimResourceKey as registrationKey };

// -- Addresses -----------------------------------------------------------------

/** The detail address: the name is the path; the other three parts of the exact identity travel in the query. */
export function registrationHref(ref: BimResourceRef, hash = ''): string {
  const query = new URLSearchParams({ namespace: ref.namespace, version: ref.version, digest: ref.digest });
  return `/app/engines/registrations/${encodeURIComponent(ref.name)}?${query.toString()}${hash}`;
}

/** The exact identity an address names, or `null` while one of its four parts is missing. */
export function refFromAddress(name: string, params: URLSearchParams): BimResourceRef | null {
  const namespace = params.get('namespace');
  const version = params.get('version');
  const digest = params.get('digest');
  return name && namespace && version && digest ? { namespace, name, version, digest } : null;
}

/** `namespace/name@version digest`: what people paste into a job or a bug report. */
export function exactReference(ref: BimResourceRef): string {
  return `${ref.namespace}/${ref.name}@${ref.version} ${ref.digest}`;
}

export function sameRevision(a: BimResourceRef, b: BimResourceRef): boolean {
  return a.namespace === b.namespace && a.name === b.name && a.version === b.version && a.digest === b.digest;
}

// -- Lifecycle wording -----------------------------------------------------------

export const PUBLICATION: Record<EngineRegistrationState, { label: string; tone: ChipTone; text: string }> = {
  private: { label: 'Private', tone: 'plain', text: 'Only your account can see and use it. Administrators cannot discover it until you request publication.' },
  pending_review: { label: 'Waiting for review', tone: 'warning', text: 'An administrator is reviewing this exact revision. It stays private until then.' },
  published: { label: 'Published', tone: 'success', text: 'Everyone can pick it when launching a job.' },
  rejected: { label: 'Rejected', tone: 'error', text: 'A reviewer declined the request, so it is private again. You can ask again.' },
};

export function publicationOf(status: EngineRegistrationState): { label: string; tone: ChipTone; text: string } {
  return PUBLICATION[status] ?? PUBLICATION.private;
}

export function activityOf(registration: Pick<EngineRegistrationRevision, 'active'>): { label: string; tone: ChipTone } {
  return registration.active ? { label: 'Active', tone: 'info' } : { label: 'Inactive', tone: 'plain' };
}

/** Where a registration stands on the way to publication: 0 private, 1 waiting for review, 2 published. */
export function publicationStep(status: EngineRegistrationState): number {
  return status === 'published' ? 2 : status === 'pending_review' ? 1 : 0;
}

// -- The conformance probe --------------------------------------------------------------

export type CheckState = 'passed' | 'failed' | 'pending';

export interface ProbeCheck {
  id: string;
  label: string;
  detail: string;
  state: CheckState;
}

export type ProbeVerdict = 'verified' | 'failed' | 'pending';

export interface Probe {
  verdict: ProbeVerdict;
  checks: ProbeCheck[];
  verifiedAt: string | null;
  durationMs: number | null;
  protocol: string | null;
  protocolDigest: string | null;
}

const PASSED = new Set(['passed', 'pass', 'ok', 'verified', 'success', 'succeeded']);
const FAILED = new Set(['failed', 'fail', 'error', 'rejected', 'refused']);

function humanize(id: string): string {
  const words = id.replace(/[-_.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** One entry of the gateway's `checks`, in words. The gateway names `openapi`, `health`, `binding-result` and, on failure, `conformance`. */
export function describeCheck(raw: unknown, index: number): ProbeCheck {
  const entry = isRecord(raw) ? raw : {};
  const id = text(entry.id) ?? text(entry.name) ?? text(entry.check) ?? `check-${index + 1}`;
  const word = (text(entry.status) ?? text(entry.result) ?? 'pending').toLowerCase();
  const state: CheckState = PASSED.has(word) ? 'passed' : FAILED.has(word) ? 'failed' : 'pending';
  const message = text(entry.message) ?? text(entry.detail) ?? text(entry.error);
  switch (id) {
    case 'openapi': {
      const modes = Array.isArray(entry.responseModes) ? entry.responseModes.filter((item): item is string => typeof item === 'string') : [];
      const path = text(entry.requestPath);
      const parts = [path ? `Solve path ${path}` : null, modes.length ? `${modes.join(' and ')} answers` : null].filter((part): part is string => part !== null);
      return { id, state, label: 'Contract matches bim-engine/v1', detail: message ?? (parts.join(' · ') || 'The served OpenAPI document is the pinned one.') };
    }
    case 'health':
      return { id, state, label: 'Health path answered', detail: message ?? 'The mapped health operation answered 200.' };
    case 'binding-result': {
      const termination = text(entry.termination);
      return { id, state, label: 'Sample problem solved', detail: message ?? (termination ? `It ended ${termination} with the expected binding.` : 'The answer has the expected shape.') };
    }
    case 'conformance':
      return { id, state, label: 'Conformance check', detail: message ?? 'The deployment did not pass.' };
    default:
      return { id, state, label: humanize(id), detail: message ?? '' };
  }
}

/** What the last probe found. A report that is missing or still `pending` reads as "not checked yet". */
export function readProbe(report: unknown): Probe {
  const body = isRecord(report) ? report : {};
  const checks = Array.isArray(body.checks) ? body.checks.map(describeCheck) : [];
  const word = text(body.status)?.toLowerCase() ?? 'pending';
  const verdict: ProbeVerdict = word === 'verified' ? 'verified' : word === 'failed' ? 'failed' : 'pending';
  return {
    verdict,
    checks,
    verifiedAt: text(body.verifiedAt),
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
    protocol: text(body.protocol),
    protocolDigest: text(body.protocolDigest),
  };
}

/** The checks a refused activation (409 `conformance_failed`) carries as its diagnostics. */
export function probeFromFailure(error: unknown): Probe | null {
  if (!(error instanceof HttpError) || error.code !== 'conformance_failed') return null;
  const checks = (error.diagnostics ?? []).map(describeCheck);
  return { verdict: 'failed', checks, verifiedAt: null, durationMs: null, protocol: null, protocolDigest: null };
}

export function probeSummary(probe: Probe): { label: string; tone: ChipTone } {
  if (probe.verdict === 'verified') return { label: 'Passed', tone: 'success' };
  if (probe.verdict === 'failed') return { label: 'Failed', tone: 'error' };
  return { label: 'Not checked yet', tone: 'plain' };
}

// -- Failures in words ----------------------------------------------------------------------

export interface Failure {
  status: number | null;
  code: string | null;
  title: string;
  text: string;
  /** Where the gateway says the problem is (`pointer: message`), a few lines at most. */
  details: string[];
  probe: Probe | null;
  /** `warning` for "try again later"; `error` for a refusal. */
  tone: 'error' | 'warning';
}

const BY_CODE: Record<string, [string, string]> = {
  secret_in_document: [
    'Refused: there’s a secret in the document',
    'Something in the endpoint address or the contract looks like a token or password. Remove it; secrets only go in the credential step, where they’re stored encrypted and never shown again.',
  ],
  unsupported_auth: [
    'Refused: sign-in method not supported',
    'OpenBinding can’t use that sign-in method. Pick none, bearer token or username and password, and make the contract match.',
  ],
  openapi_protocol_mismatch: [
    'Refused: the contract doesn’t speak bim-engine/v1',
    'It must be OpenAPI 3.1.0 and pin the bim-engine/v1 protocol fingerprint the registration names.',
  ],
  protocol_digest_mismatch: [
    'Refused: protocol fingerprint doesn’t match',
    'The contract names bim-engine/v1 but with a fingerprint from another edition of the protocol. Rebuild it against the current one.',
  ],
  protocol_mismatch: ['Refused: wrong protocol', 'A registration must use bim-engine/v1.'],
  conformance_failed: [
    'Your deployment didn’t pass',
    'It answered, but not the way bim-engine/v1 expects. The checks are listed below. Nothing was activated and the registration itself is unchanged.',
  ],
  engine_not_granted: [
    'This key can’t create this engine',
    'The API key behind this session is limited to a list of engines. Use a key with access to all engines.',
  ],
  feature_not_entitled: [
    'Federated engines aren’t in your plan right now',
    'The request can’t be made. Your plan’s features are listed on your usage page.',
  ],
  insufficient_api_key_permission: [
    'This key doesn’t include that permission',
    'The API key behind this session lacks a permission this needs. Create a key that includes it, or use your normal session.',
  ],
  registration_inactive: [
    'It’s inactive',
    'Activate it before requesting publication. Activation re-checks your deployment.',
  ],
  immutable_published_registration: [
    'It’s published, so it can’t change',
    'Published registrations are fixed for everyone who relies on them. To change the deployment, register a new version.',
  ],
  immutable_engine: [
    'That engine version already exists with other content',
    'Engine revisions are immutable. Change the version number to register a different manifest.',
  ],
  immutable_registration: [
    'That registration version already exists with other content',
    'Registration revisions are immutable. Use a new registration version.',
  ],
  invalid_engine: ['The engine manifest was refused', 'It doesn’t satisfy the bim/v1 Engine contract. The gateway says where below.'],
  invalid_registration: ['The registration was refused', 'It doesn’t satisfy the bim/v1 EngineRegistration contract. The gateway says where below.'],
  invalid_credential: [
    'That credential was refused',
    'It was empty or not in the expected form. Nothing was replaced; the previous credential is still in use.',
  ],
  unknown_engine: ['That engine revision isn’t known', 'The registration points at an engine revision the gateway can’t find. Create the engine revision first.'],
  engine_digest_mismatch: ['The engine fingerprint doesn’t match', 'The registration must pin the exact engine revision it deploys.'],
  engine_revision_unavailable: ['The engine revision is unavailable', 'The revision this registration pins can’t be read right now.'],
  accounts_unavailable: [
    'Accounts are unavailable right now',
    'Registrations are tied to accounts, so this can’t be done. Nothing has changed; try again in a moment.',
  ],
  credential_store_unavailable: ['The credential store is unavailable', 'Nothing was stored. Try again in a moment.'],
  payload_too_large: ['That document is too large', 'Shorten the OpenAPI document or the manifest and try again.'],
};

function diagnosticLines(error: HttpError): string[] {
  return (error.diagnostics ?? [])
    .filter(isRecord)
    .map((item) => {
      const message = text(item.message) ?? text(item.code) ?? '';
      const where = text(item.pointer);
      return where ? `${where}: ${message}` : message;
    })
    .filter((line) => line !== '')
    .slice(0, 6);
}

/** Any failure of a request as a message with a status, a code and, when the gateway gave them, the places it points at. */
export function describeFailure(error: unknown, fallback = 'The request was refused.'): Failure {
  if (error instanceof QuotaError) {
    const quota = error.quota;
    const counts = quota && quota.used !== undefined ? `You’ve used ${quota.used} of ${quota.limit}. ` : '';
    return {
      status: 402, code: error.code, tone: 'error', details: [], probe: null,
      title: 'Engine limit reached (402)',
      text: `${counts}Delete a registration you no longer use, or ask about a larger plan.`,
    };
  }
  if (error instanceof HttpError) {
    const known = error.code ? BY_CODE[error.code] : undefined;
    const suffix = error.code ? ` (${error.status} · ${error.code})` : ` (${error.status})`;
    if (known) {
      return {
        status: error.status, code: error.code ?? null, tone: error.status === 503 ? 'warning' : 'error',
        title: `${known[0]}${suffix}`, text: known[1], details: error.code === 'conformance_failed' ? [] : diagnosticLines(error), probe: probeFromFailure(error),
      };
    }
    if (error.status === 401) {
      return { status: 401, code: error.code ?? null, tone: 'error', title: 'Your session ended (401)', text: 'Log in again to continue.', details: [], probe: null };
    }
    if (error.status === 403) {
      return { status: 403, code: error.code ?? null, tone: 'error', title: `You can’t do this${suffix}`, text: 'Your account or key is valid but doesn’t include what this needs.', details: diagnosticLines(error), probe: null };
    }
    if (error.status === 404) {
      return { status: 404, code: error.code ?? null, tone: 'error', title: 'Not found (404)', text: 'It doesn’t exist, or it isn’t yours. The answer is the same either way.', details: [], probe: null };
    }
    if (error.status === 503) {
      return { status: 503, code: error.code ?? null, tone: 'warning', title: `This isn’t available right now${suffix}`, text: 'A service OpenBinding depends on didn’t answer. Nothing has changed; try again in a moment.', details: [], probe: null };
    }
    return {
      status: error.status, code: error.code ?? null, tone: 'error', title: `${fallback}${suffix}`,
      text: error.message.replace(/^HTTP \d+:\s*/, ''), details: diagnosticLines(error), probe: null,
    };
  }
  return {
    status: null, code: null, tone: 'error', title: fallback,
    text: error instanceof Error ? error.message : 'The gateway can’t be reached.', details: [], probe: null,
  };
}

// -- What a registration points at ------------------------------------------------------------

export const AUTH_LABELS: Record<string, string> = {
  none: 'None (open endpoint)',
  bearer: 'Bearer token (stored encrypted)',
  basic: 'Username and password (stored encrypted)',
};

const MAPPING_LABELS: Record<string, string> = { request: 'Solve', health: 'Health', openapi: 'Contract', job: 'Job status' };
const MAPPING_ORDER = ['request', 'health', 'openapi', 'job'];

export interface DeploymentView {
  endpoint: string | null;
  auth: string;
  authScheme: string;
  protocol: string | null;
  protocolDigest: string | null;
  mappings: Array<{ id: string; label: string; path: string }>;
  contractTitle: string | null;
  contractVersion: string | null;
  contractPaths: number | null;
  contractDigest: string | null;
}

/** The secret-free description of a deployment, from its EngineRegistration manifest and the OpenAPI document pinned with it. */
export function readDeployment(manifest: unknown, openapi: unknown, contractDigest: string | null): DeploymentView {
  const spec = isRecord(manifest) && isRecord(manifest.spec) ? manifest.spec : {};
  const mappings = isRecord(spec.mappings) ? spec.mappings : {};
  const scheme = isRecord(spec.auth) && typeof spec.auth.scheme === 'string' ? spec.auth.scheme : 'none';
  const protocol = isRecord(spec.protocol) ? spec.protocol : {};
  const info = isRecord(openapi) && isRecord(openapi.info) ? openapi.info : {};
  const paths = isRecord(openapi) && isRecord(openapi.paths) ? Object.keys(openapi.paths).length : null;
  return {
    endpoint: text(spec.endpoint),
    auth: AUTH_LABELS[scheme] ?? scheme,
    authScheme: scheme,
    protocol: text(protocol.id),
    protocolDigest: text(protocol.digest),
    mappings: MAPPING_ORDER
      .filter((id) => typeof mappings[id] === 'string' && mappings[id] !== '')
      .map((id) => ({ id, label: MAPPING_LABELS[id], path: String(mappings[id]) })),
    contractTitle: text(info.title),
    contractVersion: text(info.version),
    contractPaths: paths,
    contractDigest,
  };
}

/** The address that opens the registration form filled in from this one, to register it again under a new version. */
export function newVersionHref(ref: BimResourceRef): string {
  const query = new URLSearchParams({ from: ref.name, namespace: ref.namespace, version: ref.version, digest: ref.digest });
  return `/app/engines/new?${query.toString()}`;
}

// -- The plan's room for federated engines ---------------------------------------------------

export interface Allowance {
  plan: string;
  used: number;
  /** `null`: no limit. */
  limit: number | null;
}

/** How many federated engines the plan allows and how many are in use, from the usage view; `null` when it says nothing. */
export function allowanceOf(usage: UsageView | null | undefined, ownCount: number): Allowance | null {
  if (!usage) return null;
  const reported = usage.limits?.federatedEngines;
  if (reported) {
    return { plan: usage.plan, used: Math.max(0, reported.used), limit: Number.isFinite(reported.limit) ? reported.limit : null };
  }
  const capability = usage.capabilities?.federatedEngines;
  if (capability === undefined) return null;
  return { plan: usage.plan, used: ownCount, limit: capability };
}
