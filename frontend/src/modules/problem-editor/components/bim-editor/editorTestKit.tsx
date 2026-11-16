import { fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { Organization } from '../../../../api/platform';
import type { ProblemFacts } from '../../../core/api/types';
import type { FeatureValue } from '../../../../utils/featureRange';
import { unzipPackage, zipStore } from '../../../../utils/bimZip';
import { ProblemEditor } from './ProblemEditor';

/** Shared by the tests of the problem editor: the answers of the gateway, a package, and the editor rendered at its address. */
export const ROOT = '/app/isa-demo';

/** Where the editor of the test organization keeps the draft of a new problem for Lucía. */
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

export function organization(role: Organization['effective_role'] = 'MEMBER'): Organization {
  return {
    id: 'org-isa-demo',
    slug: 'isa-demo',
    name: 'ISA Demo Group',
    parent_id: null,
    effective_role: role,
    created_at: '2026-03-03T00:00:00Z',
  };
}

export interface RenderOptions {
  role?: Organization['effective_role'];
  /** The query of the editor's address (`?problem=…`). */
  query?: string;
  /** The live check's delay; long by default, so a test checks with "Check now". */
  delay?: number;
}

/** The editor at its address; `router.state.location` is where it has gone since. */
export function renderProblemEditor({
  role = 'MEMBER',
  query = '',
  delay = 60_000,
}: RenderOptions = {}) {
  const org = organization(role);
  const router = createMemoryRouter(
    [
      {
        path: '/app/:org/problem-editor',
        element: (
          <ProblemEditor
            organization={org}
            canSave={role !== 'VIEWER'}
            userId="user-lucia"
            delay={delay}
          />
        ),
      },
      { path: '*', element: <p>elsewhere</p> },
    ],
    { initialEntries: [`${ROOT}/problem-editor${query}`] }
  );
  return { ...render(<RouterProvider router={router} />), router };
}

/** Where the router of a rendered editor is: path and query. */
export const whereOf = (router: ReturnType<typeof renderProblemEditor>['router']) =>
  `${router.state.location.pathname}${router.state.location.search}`;

/** Render the editor and wait until its package is on screen. */
export async function openProblemEditor(options: RenderOptions = {}) {
  const view = renderProblemEditor(options);
  await screen.findByRole('toolbar', { name: 'Problem editor' });
  return view;
}

/** Show one of the editor's panes. */
export function showPane(name: 'Workflow' | 'Candidates' | 'Rules' | 'Files' | 'Forms' | 'BPMN') {
  fireEvent.click(
    within(screen.getByRole('tablist', { name: 'Editor panes' })).getByRole('tab', { name })
  );
}

/** Check the package now, without waiting for the delay. */
export const checkNow = () => fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
