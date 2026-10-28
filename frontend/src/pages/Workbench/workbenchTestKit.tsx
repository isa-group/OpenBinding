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
        features: { latency: { unit: 'ms', domain: 'real', direction: 'minimize', scope: 'invocation', aggregation: 'sum' } },
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

/** That package as the bytes of a `.bim.zip`. */
export function packageArchive(name: string): ArrayBuffer {
  const bytes = zipStore(packageFilesNamed(name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function packageFile(name: string): File {
  return new File([packageArchive(name)], `${name}.bim.zip`, { type: 'application/vnd.bim+zip' });
}

const at = (id: string) => ({ resource: 'catalog', id });
const candidate = (name: string, provider: string, latency: number, cost: number) => ({ name, provider: { resource: 'catalog', id: provider }, features: { latency, cost } });

/** The compiled form `GET /v1/jobs/{id}/ir` answers: the `BindingProblem` that `readBindingProblem` reads (tasks, candidates, features with units, constraints). */
export function runProblemDocument(): Record<string, unknown> {
  return {
    apiVersion: 'bim/v1',
    kind: 'BindingProblem',
    spec: {
      application: {
        tasks: { t1: { name: 'Payment', requires: { type: 'payment' } }, t2: { name: 'Shipping', requires: { type: 'shipping' } }, t3: { name: 'Notify', requires: { type: 'notify' } } },
        features: { latency: { unit: 'ms', direction: 'minimize' }, cost: { unit: 'EUR', direction: 'minimize' } },
      },
      eligibility: { t1: [at('c1'), at('c2')], t2: [at('c3')], t3: [at('c4')] },
      candidates: {
        catalog: {
          providers: { Stripe: { name: 'Stripe' }, Adyen: { name: 'Adyen' }, DHL: { name: 'DHL' }, Twilio: { name: 'Twilio' } },
          candidates: {
            c1: candidate('Stripe EU', 'Stripe', 120, 4),
            c2: candidate('Adyen', 'Adyen', 90, 5),
            c3: candidate('DHL', 'DHL', 200, 3),
            c4: candidate('Twilio', 'Twilio', 100, 2.5),
          },
        },
      },
      constraints: [
        {
          ref: { resource: 'rules', id: 'max-latency' }, enforcement: 'hard',
          assert: { kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'latency'] }, right: { kind: 'literal', value: 600 } },
        },
      ],
      optimization: { criteria: [
        { id: 'cost', feature: { resource: 'application', id: 'cost' }, direction: 'minimize' },
        { id: 'latency', feature: { resource: 'application', id: 'latency' }, direction: 'minimize' },
      ] },
    },
  };
}

/** A finished run in the canonical shape: features, objectives with components, violations. */
export function runResult(over: Record<string, unknown> = {}) {
  return {
    termination: 'FEASIBLE',
    solutions: [{
      decision: { kind: 'binding', binding: { t1: at('c1'), t2: at('c3'), t3: at('c4') } },
      features: { latency: 420, cost: 9.5 },
      objectives: {
        type: 'MULTI', scalarization: 'pareto', penalty: 2, score: [0.3, 0.4],
        components: [{ criteria: 'cost', feature: 'cost', value: 9.5, loss: 0.3, weight: 1 }, { criteria: 'latency', feature: 'latency', value: 420, loss: 0.4, weight: 1 }],
      },
      violations: [{ constraint: { resource: 'rules', id: 'prefer-eu' }, enforcement: 'soft', penalty: 2, message: 'Prefer EU providers' }],
    }],
    ...over,
  };
}

/** The job the gateway answers for a run whose result is `result`. */
export const jobWith = (result: unknown) => ({ id: 'job-1', status: 'completed', result });

interface IrMock {
  mockResolvedValue: (value: unknown) => unknown;
  mockRejectedValue: (value: unknown) => unknown;
  mockReturnValue: (value: unknown) => unknown;
}

/** Control what `jobsApi.ir` does: answer the compiled document, refuse it (404), or never answer. */
export function answerIr(ir: IrMock, answer: 'document' | 'missing' | 'pending') {
  if (answer === 'document') ir.mockResolvedValue(runProblemDocument());
  else if (answer === 'missing') ir.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
  else ir.mockReturnValue(new Promise(() => undefined));
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
