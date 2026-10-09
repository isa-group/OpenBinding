import { describe, expect, it } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { OWNER, REPORT_FAILED, REPORT_VERIFIED, digestOf, usageOf } from './fixtures';
import {
  allowanceOf, describeCheck, describeFailure, exactReference, newVersionHref, probeFromFailure, publicationStep, readDeployment, readProbe,
  refFromAddress, registrationHref,
} from './registrationModel';

const REF = { namespace: OWNER, name: 'edge-solver', version: '0.3.1', digest: digestOf('e5') };

function problem(status: number, code: string, diagnostics?: unknown[]): HttpError {
  const error = new HttpError(status, 'refused');
  error.code = code;
  error.diagnostics = diagnostics;
  return error;
}

describe('registration addresses', () => {
  it('puts the whole exact identity in the address and reads it back', () => {
    const href = registrationHref(REF);
    const url = new URL(href, 'https://app.example');
    expect(url.pathname).toBe('/app/engines/registrations/edge-solver');
    expect(refFromAddress('edge-solver', url.searchParams)).toEqual(REF);
    expect(registrationHref(REF, '#credential')).toMatch(/#credential$/);
  });

  it('does not guess the identity when one of its four parts is missing', () => {
    expect(refFromAddress('edge-solver', new URLSearchParams({ namespace: OWNER, version: '0.3.1' }))).toBeNull();
    expect(refFromAddress('', new URLSearchParams({ namespace: OWNER, version: '1', digest: 'x' }))).toBeNull();
  });

  it('writes the exact reference people paste, and the address that registers a new version', () => {
    expect(exactReference(REF)).toBe(`${OWNER}/edge-solver@0.3.1 ${REF.digest}`);
    const query = new URL(newVersionHref(REF), 'https://app.example').searchParams;
    expect(query.get('from')).toBe('edge-solver');
    expect(query.get('digest')).toBe(REF.digest);
  });

  it('places a status on the way to publication', () => {
    expect(['private', 'rejected', 'pending_review', 'published'].map((status) => publicationStep(status as never))).toEqual([0, 0, 1, 2]);
  });
});

describe('the conformance probe', () => {
  it('names the checks the gateway makes in words', () => {
    const probe = readProbe(REPORT_VERIFIED);
    expect(probe.verdict).toBe('verified');
    expect(probe.checks.map((check) => check.label)).toEqual(['Contract matches bim-engine/v1', 'Health path answered', 'Sample problem solved']);
    expect(probe.checks[0].detail).toBe('Solve path /internal/v1/binding-problems · synchronous answers');
    expect(probe.checks[2].detail).toBe('It ended FEASIBLE with the expected binding.');
    expect(probe.durationMs).toBeCloseTo(1460.2);
    expect(probe.protocolDigest).toBe(REPORT_VERIFIED.protocolDigest);
  });

  it('shows what failed, with the gateway’s own message', () => {
    const probe = readProbe(REPORT_FAILED);
    expect(probe.verdict).toBe('failed');
    const failed = probe.checks.filter((check) => check.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toBe('engine did not solve the deterministic conformance problem');
  });

  it('reads a report that is missing or still pending as not checked', () => {
    expect(readProbe(null).verdict).toBe('pending');
    expect(readProbe({ status: 'pending', checks: [] }).checks).toEqual([]);
  });

  it('keeps an unknown check with the words it came with', () => {
    expect(describeCheck({ name: 'dns-resolution', result: 'ok', detail: 'Resolved' }, 0)).toEqual({
      id: 'dns-resolution', label: 'Dns resolution', detail: 'Resolved', state: 'passed',
    });
    expect(describeCheck('nonsense', 3).id).toBe('check-4');
  });

  it('takes the checks of a refused activation from its diagnostics', () => {
    const probe = probeFromFailure(problem(409, 'conformance_failed', REPORT_FAILED.checks));
    expect(probe?.verdict).toBe('failed');
    expect(probe?.checks).toHaveLength(3);
    expect(probeFromFailure(problem(409, 'registration_inactive'))).toBeNull();
    expect(probeFromFailure(new Error('x'))).toBeNull();
  });
});

describe('failures in words', () => {
  it('explains the refusals the gateway gives for a registration, with status and code', () => {
    const secret = describeFailure(problem(422, 'secret_in_document', [{ code: 'secret_in_document', pointer: '/spec/endpoint', message: 'secret-like field is forbidden' }]));
    expect(secret.title).toBe('Refused: there’s a secret in the document (422 · secret_in_document)');
    expect(secret.details).toEqual(['/spec/endpoint: secret-like field is forbidden']);

    expect(describeFailure(problem(409, 'registration_inactive')).title).toBe('It’s inactive (409 · registration_inactive)');
    expect(describeFailure(problem(409, 'immutable_published_registration')).text).toMatch(/register a new version/);
    expect(describeFailure(problem(403, 'engine_not_granted')).title).toBe('This key can’t create this engine (403 · engine_not_granted)');
    expect(describeFailure(problem(403, 'feature_not_entitled')).title).toMatch(/Federated engines aren’t in your plan/);
  });

  it('reads a failed conformance check as a probe, not as a list of codes', () => {
    const failure = describeFailure(problem(409, 'conformance_failed', REPORT_FAILED.checks));
    expect(failure.title).toBe('Your deployment didn’t pass (409 · conformance_failed)');
    expect(failure.probe?.checks.find((check) => check.state === 'failed')?.label).toBe('Conformance check');
    expect(failure.details).toEqual([]);
  });

  it('tells the plan limit from other refusals (402) and uses the counts the gateway sent', () => {
    const failure = describeFailure(new QuotaError('quota_exceeded', 'limit', { limit_id: 'federatedEngines', limit: 5, used: 5 }));
    expect(failure.status).toBe(402);
    expect(failure.title).toBe('Engine limit reached (402)');
    expect(failure.text).toMatch(/You’ve used 5 of 5/);
  });

  it('treats 503 as try later, 404 as nothing you can see, and a network failure as plain words', () => {
    expect(describeFailure(problem(503, 'accounts_unavailable')).tone).toBe('warning');
    expect(describeFailure(problem(404, 'not_found')).text).toMatch(/same either way/);
    const offline = describeFailure(new Error('Failed to fetch'), 'The request failed');
    expect(offline).toMatchObject({ status: null, title: 'The request failed', text: 'Failed to fetch' });
  });
});

describe('what a registration points at', () => {
  it('lays out the deployment without a secret anywhere', () => {
    const deployment = readDeployment(
      {
        spec: {
          endpoint: 'https://edge.example.org', protocol: { id: 'bim-engine/v1', digest: digestOf('c3d4') }, auth: { scheme: 'basic' },
          mappings: { openapi: '/openapi.json', request: '/solve', health: '/health', job: '/jobs/{id}' },
        },
      },
      { info: { title: 'edge', version: '1.0.0' }, paths: { '/solve': {}, '/health': {} } },
      digestOf('f0'),
    );
    expect(deployment.auth).toBe('Username and password (stored encrypted)');
    expect(deployment.mappings.map((item) => `${item.label} ${item.path}`)).toEqual(['Solve /solve', 'Health /health', 'Contract /openapi.json', 'Job status /jobs/{id}']);
    expect(deployment).toMatchObject({ contractTitle: 'edge', contractVersion: '1.0.0', contractPaths: 2, endpoint: 'https://edge.example.org' });
  });

  it('copes with a manifest it cannot read', () => {
    expect(readDeployment(null, null, null)).toMatchObject({ endpoint: null, auth: 'None (open endpoint)', mappings: [], contractPaths: null });
  });
});

describe('the plan’s room for federated engines', () => {
  it('uses the usage the gateway reports', () => {
    expect(allowanceOf(usageOf('RESEARCH', 2, 5), 0)).toEqual({ plan: 'RESEARCH', used: 2, limit: 5 });
  });

  it('falls back to the allowance and the count of own registrations, and says nothing when there is none', () => {
    const noLimits = { ...usageOf('BASIC', 0, 1), limits: {} };
    expect(allowanceOf(noLimits, 1)).toEqual({ plan: 'BASIC', used: 1, limit: 1 });
    expect(allowanceOf({ ...noLimits, capabilities: {} }, 1)).toBeNull();
    expect(allowanceOf(null, 1)).toBeNull();
  });
});
