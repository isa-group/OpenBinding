import { describe, expect, it } from 'vitest';
import { OPENAPI_DOCUMENT, PROTOCOL_DIGEST, REGISTRATION_MANIFEST, digestOf } from '../Engines/fixtures';
import { issueAt } from './engineDraft';
import {
  analyzeContract, buildRegistration, deploymentFromManifest, endpointProblem, newDeployment, pathProblem, validateDeployment,
} from './deploymentDraft';

const MAPPED = ['/internal/v1/binding-problems', '/health', '/openapi.json'];
const CONTRACT = JSON.stringify(OPENAPI_DOCUMENT);

describe('endpoint addresses', () => {
  it('asks for a full address, and keeps secrets out of it', () => {
    expect(endpointProblem('')).toBe('Enter the address of your deployment.');
    expect(endpointProblem('solver.example')).toBe('Use a full https:// address.');
    expect(endpointProblem('https://solver.example')).toBeNull();
    expect(endpointProblem('https://solver.example/v1?token=abc')).toBe('This looks like it contains a secret. Remove it.');
    expect(endpointProblem('https://user:pass@solver.example')).toBe('This looks like it contains a secret. Remove it.');
  });

  it('wants mapped paths that start with a slash; the job path alone is optional', () => {
    expect(pathProblem('', true)).toBe('Required.');
    expect(pathProblem('', false)).toBeNull();
    expect(pathProblem('health', true)).toBe('Start with / and use no spaces.');
    expect(pathProblem('/internal/v1/jobs/{id}', false)).toBeNull();
  });
});

describe('reading the pinned contract', () => {
  it('passes a document that declares 3.1.0, its title, its paths and the gateway’s protocol fingerprint', () => {
    const reading = analyzeContract(CONTRACT, MAPPED, PROTOCOL_DIGEST);
    expect(reading.state).toBe('read');
    expect(reading.ok).toBe(true);
    expect(reading.checks.map((check) => [check.label, check.value])).toEqual([
      ['OpenAPI version', '3.1.0'],
      ['Title and version', 'edge-solver 0.3.1'],
      ['Paths', '3 paths, including 3 of the 3 mapped'],
      ['Protocol', 'bim-engine/v1'],
      ['Protocol fingerprint', 'Matches'],
    ]);
  });

  it('names each check that fails', () => {
    const wrong = JSON.stringify({ openapi: '3.0.3', paths: {}, 'x-bim-protocol': 'other', 'x-bim-protocol-digest': digestOf('aa') });
    const reading = analyzeContract(wrong, MAPPED, PROTOCOL_DIGEST);
    expect(reading.ok).toBe(false);
    expect(reading.checks.filter((check) => !check.ok).map((check) => check.id)).toEqual(['version', 'info', 'paths', 'protocol', 'fingerprint']);
    expect(reading.checks.find((check) => check.id === 'fingerprint')?.value).toBe('Different from bim-engine/v1’s');
  });

  it('does not claim a match when the gateway’s fingerprint could not be read', () => {
    const reading = analyzeContract(CONTRACT, MAPPED, null);
    expect(reading.ok).toBe(false);
    expect(reading.checks.find((check) => check.id === 'fingerprint')?.value).toMatch(/Can’t compare/);
  });

  it('tells empty from text that is not a JSON object', () => {
    expect(analyzeContract('  ', MAPPED, null).state).toBe('empty');
    expect(analyzeContract('{oops', MAPPED, null)).toMatchObject({ state: 'invalid', message: 'The deployment OpenAPI document must be valid JSON.' });
    expect(analyzeContract('[1]', MAPPED, null)).toMatchObject({ state: 'invalid', message: 'The deployment OpenAPI document must be a JSON object.' });
  });
});

describe('validating the deployment before anything is created', () => {
  const ready = { ...newDeployment(), endpoint: 'https://solver.example', contract: CONTRACT };

  it('is valid once the address, the paths and the contract are', () => {
    expect(validateDeployment(ready, analyzeContract(CONTRACT, MAPPED, PROTOCOL_DIGEST))).toEqual([]);
  });

  it('points at what is missing', () => {
    const issues = validateDeployment({ ...newDeployment(), health: 'health', name: '-x', version: '0.1' }, analyzeContract('', MAPPED, null));
    expect(issueAt(issues, 'endpoint')).toBe('Enter the address of your deployment.');
    expect(issueAt(issues, 'health')).toBe('Start with / and use no spaces.');
    expect(issueAt(issues, 'name')).toMatch(/Start with a letter or digit/);
    expect(issueAt(issues, 'version')).toMatch(/three numbers/);
    expect(issueAt(issues, 'contract')).toBe('Add the deployment’s OpenAPI file to continue.');
  });

  it('refuses a contract that does not pass every check', () => {
    const reading = analyzeContract(JSON.stringify({ openapi: '3.0.3' }), MAPPED, PROTOCOL_DIGEST);
    expect(issueAt(validateDeployment(ready, reading), 'contract')).toBe('The contract doesn’t pass every check.');
  });
});

describe('the registration document', () => {
  const engine = { namespace: 'alice', name: 'my-engine', version: '1.0.0', digest: digestOf('aa') };
  const protocol = { id: 'bim-engine/v1', digest: PROTOCOL_DIGEST };

  it('pins the exact engine revision and carries no secret, whatever sign-in the deployment uses', () => {
    const draft = { ...newDeployment(), endpoint: ' https://solver.example ', auth: 'bearer' as const, job: '/internal/v1/jobs/{id}' };
    const registration = buildRegistration(draft, engine, 'alice', protocol, OPENAPI_DOCUMENT);
    expect(registration).toEqual({
      apiVersion: 'bim/v1',
      kind: 'EngineRegistration',
      metadata: { namespace: 'alice', name: 'my-engine-deployment', version: '1.0.0' },
      spec: {
        engine,
        endpoint: 'https://solver.example',
        protocol: { id: 'bim-engine/v1', mediaType: 'application/json', digest: PROTOCOL_DIGEST },
        mappings: { request: '/internal/v1/binding-problems', health: '/health', openapi: '/openapi.json', job: '/internal/v1/jobs/{id}' },
        auth: { scheme: 'bearer' },
        openapi: OPENAPI_DOCUMENT,
      },
    });
  });

  it('uses the registration name and version when they are given', () => {
    const draft = { ...newDeployment(), endpoint: 'https://solver.example', name: ' edge ', version: '2.0.0' };
    expect(buildRegistration(draft, engine, 'alice', protocol, OPENAPI_DOCUMENT).metadata).toEqual({ namespace: 'alice', name: 'edge', version: '2.0.0' });
  });

  it('is read back into the form to register the same deployment again', () => {
    const draft = deploymentFromManifest(REGISTRATION_MANIFEST, OPENAPI_DOCUMENT);
    expect(draft).toMatchObject({ endpoint: 'https://edge.example.org', auth: 'bearer', request: '/internal/v1/binding-problems', job: '' });
    expect(JSON.parse(draft.contract)).toEqual(OPENAPI_DOCUMENT);
  });
});
