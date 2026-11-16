import type { ProblemFacts } from '../../modules/core/api/types';

/** Shared by the tests of the case screens and the browser specs: digests, the facts of a compiled checkout and the contents of its package. */
export const digestOf = (char: string) => `sha256-${char.repeat(64)}`;

/**
 * The compiled `BindingProblem` of the checkout as the gateway serves it for downloads and the source view. The browser shows these
 * bytes and never reads them: what a screen draws comes from the facts below.
 */
export function compiledDocument(): Record<string, unknown> {
  return { apiVersion: 'bim/v1', kind: 'BindingProblem', metadata: { name: 'checkout' }, spec: {} };
}

/**
 * The facts of the compiled checkout (`GET …/compilations/{compilation}/facts`): authenticate, then stock and shipping in parallel,
 * then one of two payments by probability, then a local notification. `pay` is how many candidates the card payment has (the
 * transfer has half). The authenticate candidates show every kind of value: a number, a closed range, one open above and one
 * open below.
 */
export function checkoutFacts(pay = 8): ProblemFacts {
  const candidates: ProblemFacts['candidates'] = [];
  const tasks: ProblemFacts['tasks'] = [];
  const origin = (id: string, feature: string) => ({
    kind: 'package' as const,
    resource: 'providers',
    path: 'candidates.json',
    pointer: `/spec/candidates/${id}/features/${feature}`,
  });
  const add = (task: string, count: number) => {
    const eligible: ProblemFacts['tasks'][number]['eligible'] = [];
    for (let index = 1; index <= count; index += 1) {
      const id = `${task}-${index}`;
      let values: ProblemFacts['candidates'][number]['values'] = {
        latency: index * 40,
        cost: { min: index / 100, max: index / 50 },
      };
      if (task === 'authenticate' && index === 3)
        values = { latency: { min: 100, max: null }, cost: { min: null, max: 0.05 } };
      if (task === 'authenticate' && index === 4)
        values = { latency: { min: null, max: null }, cost: 0.04 };
      candidates.push({
        key: `providers/${id}`,
        resource: 'providers',
        id,
        provider: 'acme',
        values,
        origins: { latency: origin(id, 'latency'), cost: origin(id, 'cost') },
      });
      eligible.push({ candidate: `providers/${id}`, written: id });
    }
    tasks.push({ id: task, kind: 'service', eligible });
  };
  const transfer = Math.max(1, Math.floor(pay / 2));
  add('authenticate', 4);
  add('inventory', 5);
  add('shipping', 3);
  add('pay-card', pay);
  add('pay-transfer', transfer);
  tasks.push({ id: 'notify', kind: 'local', eligible: [] });
  const path = (...segments: string[]) => ({ kind: 'path', segments });
  const literal = (value: unknown) => ({ kind: 'literal', value });
  return {
    binding_space: String(4 * 5 * 3 * pay * transfer),
    candidates: candidates.sort((a, b) => a.key.localeCompare(b.key)),
    constraints: [
      {
        id: 'rules/sla-latency',
        enforcement: 'hard',
        when: literal(true),
        penalty: null,
        expression: {
          kind: 'compare',
          op: 'lte',
          left: path('features', 'latency'),
          right: literal(600),
        },
        origin: { resource: 'rules', path: 'rules.json', pointer: '/spec/constraints/sla-latency' },
      },
      {
        id: 'rules/sla-availability',
        enforcement: 'soft',
        when: literal(true),
        penalty: literal(5),
        expression: {
          kind: 'compare',
          op: 'gte',
          left: path('features', 'availability'),
          right: literal(99.9),
        },
        origin: {
          resource: 'rules',
          path: 'rules.json',
          pointer: '/spec/constraints/sla-availability',
        },
      },
    ],
    features: [
      { id: 'latency', unit: 'ms', direction: 'min', required: true },
      { id: 'cost', unit: 'EUR', direction: 'min', required: true },
    ],
    ir_digest: digestOf('c'),
    objectives: {
      criteria: [
        { id: 'cost', feature: { resource: 'app', id: 'cost' }, direction: 'minimize' },
        {
          id: 'latency',
          feature: { resource: 'app', id: 'latency' },
          direction: 'minimize',
          normalize: { min: 0, max: 1000, clamp: true },
        },
      ],
      penalties: [{ constraint: { resource: 'rules', id: 'sla-availability' }, weight: 5 }],
    },
    tasks,
    workflow: {
      seq: [
        'authenticate',
        { and: ['inventory', 'shipping'] },
        {
          xor: [
            { probability: 0.7, flow: 'pay-card' },
            { probability: 0.3, flow: 'pay-transfer' },
          ],
        },
        'notify',
      ],
    },
  };
}

/** The resources of the checkout package: its application, candidates, rules and goal. */
export const sourceContents = {
  application: {
    apiVersion: 'qos-binding/v1',
    kind: 'Application',
    metadata: { name: 'checkout-app' },
    spec: {
      tasks: {
        authenticate: 'auth',
        inventory: 'stock',
        shipping: { kind: 'service', requires: { type: 'shipping' } },
        notify: { kind: 'local' },
      },
      features: {},
      workflow: {},
    },
  },
  catalog: {
    apiVersion: 'qos-binding/v1',
    kind: 'CandidateCatalog',
    metadata: { name: 'providers-eu' },
    spec: {
      featureBindings: {},
      candidates: {
        a1: { provides: 'auth', features: {} },
        a2: { provides: { type: 'auth' }, features: {} },
        s1: { provides: 'stock', features: {} },
        s2: { provides: ['stock', 'shipping'], features: {} },
        s3: { provides: 'shipping', features: {} },
      },
    },
  },
  rules: {
    apiVersion: 'qos-binding/v1',
    kind: 'ConstraintSet',
    metadata: { name: 'sla' },
    spec: {
      constraints: [
        { assert: {}, enforcement: 'hard' },
        { assert: {}, enforcement: 'soft', penalty: {} },
      ],
    },
  },
  goal: {
    apiVersion: 'qos-binding/v1',
    kind: 'Optimization',
    metadata: { name: 'goal' },
    spec: {
      criteria: [
        { id: 'cost', feature: { resource: 'app', id: 'cost' } },
        { id: 'latency', feature: { resource: 'app', id: 'latency' } },
      ],
    },
  },
};
