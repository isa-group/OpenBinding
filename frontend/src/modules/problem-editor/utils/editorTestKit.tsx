import type { ProblemFacts } from '../../core/api/types';
import type { FeatureValue } from '../../core/utils/featureRange';
import { unzipPackage, zipStore } from '../../core/utils/bimZip';

/** Shared by the tests of the problem editor: the answers of the gateway, a package, and the editor rendered at its address. */

/** Where the editor of the test organization keeps the draft of a new problem for the test account. */
export const DRAFT_SCOPE = 'user-lucia:problem:isa-demo:new:none';

export const ENGINE_REF = {
  namespace: 'bim.builtin',
  name: 'random-search',
  version: '1.0.0',
  digest: 'sha256-a',
};
export const REGISTRATION_REF = {
  namespace: 'bim.builtin',
  name: 'random-search-deployment',
  version: '1.0.0+builtin.a',
  digest: 'sha256-registration-a',
};

const digest = (char: string) => `sha256-${char.repeat(64)}`;

/** What `POST /v1/bim/validate` answers for a package it accepts. */
export function analysis(over: Record<string, unknown> = {}) {
  return {
    valid: true as const,
    instanceDigest: digest('a'),
    packageDigest: digest('b'),
    irDigest: digest('c'),
    fileDigests: {},
    resourceDigests: {},
    diagnostics: [],
    compatibleModes: [
      { engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true },
    ],
    analysis: { tasks: 1, candidates: 2, constraints: 0, placement: false, bindingSpace: '128' },
    ...over,
  };
}

/** Where the blank package writes the latency of its one candidate. */
export const BLANK_LATENCY = '/spec/candidates/service-a/features/latency';

/** The facts the gateway answers for the blank package (`DEFAULT_FILES`), with `latency` as the value it read (`null`: none). */
export function blankFacts(latency: FeatureValue | null = 10): ProblemFacts {
  const origin = {
    kind: 'package' as const,
    resource: 'catalog',
    path: 'candidates.json',
    pointer: BLANK_LATENCY,
  };
  return {
    binding_space: '1',
    candidates: [
      {
        id: 'service-a',
        key: 'catalog/service-a',
        resource: 'catalog',
        provider: null,
        values: latency === null ? {} : { latency },
        origins: latency === null ? {} : { latency: origin },
        properties: {},
        propertyOrigins: {},
        provenance: null,
      },
    ],
    constraints: [],
    features: [{ id: 'latency', unit: 'ms', direction: 'min', required: true }],
    ir_digest: digest('c'),
    objectives: {
      criteria: [{ id: 'latency', feature: { resource: 'application', id: 'latency' } }],
      penalties: [],
    },
    tasks: [
      {
        id: 'hello',
        kind: 'service',
        eligible: [{ candidate: 'catalog/service-a', written: 'service-a' }],
      },
    ],
    workflow: { seq: ['hello'] },
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The files of a small package whose name is `name`. */
export function packageFilesNamed(name: string): Record<string, string> {
  return {
    'instance.json': json({
      apiVersion: 'bim/v1',
      kind: 'Instance',
      metadata: { name },
      spec: {
        profile: 'qos-binding/v1',
        resources: {
          application: { application: 'application.json' },
          candidateCatalog: { catalog: 'candidates.json' },
          optimization: { optimization: 'optimization.json' },
        },
      },
    }),
    'application.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'Application',
      metadata: { name: `${name}-application` },
      spec: {
        tasks: { hello: 'http' },
        features: {
          latency: {
            unit: 'ms',
            domain: 'real',
            direction: 'minimize',
            scope: 'invocation',
            aggregation: 'sum',
          },
        },
        workflow: { task: { resource: 'application', id: 'hello' } },
      },
    }),
    'candidates.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'CandidateCatalog',
      metadata: { name: `${name}-candidates` },
      spec: {
        featureBindings: { latency: { resource: 'application', id: 'latency' } },
        candidates: { candidate: { provides: 'http', features: { latency: 10 } } },
      },
    }),
    'optimization.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'Optimization',
      metadata: { name: `${name}-optimization` },
      spec: { criteria: [{ id: 'latency', feature: { resource: 'application', id: 'latency' } }] },
    }),
  };
}

/** Files as the bytes of a `.bim.zip`. */
export function archiveOf(files: Record<string, string>): ArrayBuffer {
  const bytes = zipStore(files);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The files the gateway was asked to check by one call of a mocked `bimApi.validate`. */
export async function sentFiles(
  validate: { mock: { calls: unknown[][] } },
  call = validate.mock.calls.length - 1
): Promise<Record<string, string>> {
  const archive = validate.mock.calls[call][0] as Uint8Array;
  return unzipPackage(
    archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer
  );
}
