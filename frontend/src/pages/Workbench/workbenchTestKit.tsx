import { screen } from '@testing-library/react';
import type { UserProfile } from '../../api/auth';
import type { Organization } from '../../api/platform';
import { zipStore } from '../../utils/bimZip';
import { org, renderProjectScreen } from '../Project/testKit';
import { Workbench } from './Workbench';

/** Shared by the tests of the workbench: the answers of the gateway, a package to bring in, and the screen rendered at its address. */
export const ROOT = '/app/isa-demo/qos-benchmarks';

export const ENGINE_REF = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
export const REGISTRATION_REF = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1.0.0+builtin.a', digest: 'sha256-registration-a' };
export const SECOND_REGISTRATION = { namespace: 'acme', name: 'random-search-eu', version: '2.0.0', digest: 'sha256-registration-b' };

const digest = (char: string) => `sha256-${char.repeat(64)}`;

/** What `POST /v1/validate` answers for a package it accepts. */
export function analysis(over: Record<string, unknown> = {}) {
  return {
    valid: true,
    instanceDigest: digest('a'),
    packageDigest: digest('b'),
    irDigest: digest('c'),
    fileDigests: {},
    resourceDigests: {},
    diagnostics: [],
    compatibleModes: [{ engine: ENGINE_REF, registration: REGISTRATION_REF, mode: 'seeded', compatible: true }],
    analysis: { tasks: 1, candidates: 2, constraints: 0, placement: false, bindingSpace: '128' },
    ...over,
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
        metrics: { latency: { unit: 'ms', domain: 'real', direction: 'minimize', scope: 'invocation', aggregation: 'sum' } },
        workflow: { task: 'hello' },
      },
    }),
    'candidates.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'CandidateCatalog',
      metadata: { name: `${name}-candidates` },
      spec: {
        metricBindings: { latency: { resource: 'application', id: 'latency' } },
        candidates: { candidate: { provides: 'http', metrics: { latency: 10 } } },
      },
    }),
    'optimization.json': json({
      apiVersion: 'qos-binding/v1',
      kind: 'Optimization',
      metadata: { name: `${name}-optimization` },
      spec: { mode: 'weighted', terms: [{ metric: { resource: 'application', id: 'latency' }, weight: 1 }] },
    }),
  };
}

/** That package as the bytes of a `.bim.zip`. */
export function packageArchive(name: string): ArrayBuffer {
  const bytes = zipStore(packageFilesNamed(name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function packageFile(name: string): File {
  return new File([packageArchive(name)], `${name}.bim.zip`, { type: 'application/vnd.bim+zip' });
}

interface RenderOptions {
  role?: Organization['effective_role'];
  query?: string;
  user?: UserProfile;
}

export function renderWorkbench(options: RenderOptions = {}) {
  const organization = org('isa-demo', { name: 'ISA Demo Group', effective_role: options.role ?? 'MEMBER' });
  return renderProjectScreen(<Workbench />, {
    path: '/app/:org/:project/workbench', url: `${ROOT}/workbench${options.query ?? ''}`, organizations: [organization], user: options.user,
  });
}

/** Render the workbench and wait until its package is on screen. */
export async function openWorkbench(options: RenderOptions = {}) {
  const view = renderWorkbench(options);
  await screen.findByRole('navigation', { name: 'BIM resources' });
  return view;
}
