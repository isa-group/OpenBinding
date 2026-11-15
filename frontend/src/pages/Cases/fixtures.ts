/** Shared by the tests of the case screens: digests, a compiled form to read and the contents of a checkout package. */
export const digestOf = (char: string) => `sha256-${char.repeat(64)}`;

const taskRef = (id: string) => ({ resource: 'app', id });
const node = (id: string) => ({ kind: 'task', task: taskRef(id) });

/**
 * A compiled `BindingProblem` for a checkout: authenticate, then stock and shipping in parallel, then one of two payments by
 * probability, then a local notification. `pay` is how many candidates the card payment has (the transfer has half).
 */
export function irDocument(pay = 8): Record<string, unknown> {
  const candidates: Record<string, unknown> = {};
  const eligibility: Record<string, Array<{ resource: string; id: string }>> = {};
  const add = (task: string, capability: string, count: number) => {
    eligibility[task] = [];
    for (let index = 1; index <= count; index += 1) {
      const id = `${task}-${index}`;
      candidates[id] = {
        ref: { resource: 'providers', id }, name: `${capability}-${index}`, provider: { resource: 'providers', id: 'acme' },
        provides: [{ type: capability, properties: {} }], properties: {},
        features: { latency: index * 40, cost: { min: index / 100, max: index / 50 } },
      };
      // The authenticate providers show every kind of value: a number, a closed range, one open above and one open below.
      if (task === 'authenticate' && index === 3) (candidates[id] as { features: Record<string, unknown> }).features = { latency: { min: 100, max: null }, cost: { min: null, max: 0.05 } };
      if (task === 'authenticate' && index === 4) (candidates[id] as { features: Record<string, unknown> }).features = { latency: { min: null, max: null }, cost: 0.04 };
      eligibility[task].push({ resource: 'providers', id });
    }
  };
  add('authenticate', 'auth', 4);
  add('inventory', 'stock', 5);
  add('shipping', 'shipping', 3);
  add('pay-card', 'payment', pay);
  add('pay-transfer', 'payment', Math.max(1, Math.floor(pay / 2)));
  const service = (capability: string) => ({ kind: 'service', requires: { type: capability } });
  return {
    apiVersion: 'bim/v1',
    kind: 'BindingProblem',
    metadata: { name: 'checkout' },
    spec: {
      profile: { namespace: 'bim.builtin', id: 'qos-binding/v1', version: '1.0.0', digest: digestOf('a'), adapter: { id: 'qos-adapter', version: '1.0.0', digest: digestOf('b') } },
      dialects: [{ namespace: 'bim.builtin', id: 'qos-dialect/v1', version: '1.0.0', digest: digestOf('d'), irFeatures: [], adapter: { id: 'qos-adapter', version: '1.0.0', digest: digestOf('b') } }],
      instance: { digest: digestOf('e'), resources: {} },
      application: {
        resource: 'app',
        tasks: {
          authenticate: service('auth'), inventory: service('stock'), shipping: service('shipping'),
          'pay-card': service('payment'), 'pay-transfer': service('payment'), notify: { kind: 'local' },
        },
        features: { latency: { unit: 'ms', direction: 'minimize' }, cost: { unit: 'EUR', direction: 'minimize' } },
        requiredFeatures: [],
        taskRequiredFeatures: {},
        workflow: {
          kind: 'sequence',
          steps: [
            node('authenticate'),
            { kind: 'parallel', branches: [node('inventory'), node('shipping')] },
            { kind: 'exclusive', branches: [{ id: 'card', flow: node('pay-card') }, { id: 'transfer', flow: node('pay-transfer') }] },
            node('notify'),
          ],
        },
      },
      candidates: { providers: { providers: { acme: { name: 'Acme' } }, featureBindings: {}, candidates } },
      eligibility,
      routing: [
        { target: { resource: 'flow', id: 'card' }, probability: 0.7 },
        { target: { resource: 'flow', id: 'transfer' }, probability: 0.3 },
      ],
      constraints: [
        {
          ref: { resource: 'rules', id: 'sla-latency' }, when: { kind: 'literal', value: true }, enforcement: 'hard',
          assert: { kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'latency'] }, right: { kind: 'literal', value: 600 } },
        },
        {
          ref: { resource: 'rules', id: 'sla-availability' }, when: { kind: 'literal', value: true }, enforcement: 'soft',
          assert: { kind: 'compare', op: 'gte', left: { kind: 'path', segments: ['features', 'availability'] }, right: { kind: 'literal', value: 99.9 } },
          penalty: { kind: 'literal', value: 5 },
        },
      ],
      placement: [],
      optimization: {
        resource: 'goal',
        criteria: [
          { id: 'cost', feature: { resource: 'app', id: 'cost' }, direction: 'minimize' },
          { id: 'latency', feature: { resource: 'app', id: 'latency' }, direction: 'minimize', normalize: { min: 0, max: 1000, clamp: true } },
        ],
        penalties: [{ constraint: { resource: 'rules', id: 'sla-availability' }, weight: 5 }],
      },
      extensions: {},
      sourceMap: {},
    },
  };
}

/** The resources of the checkout package: its application, candidates, rules and goal. */
export const sourceContents = {
  application: {
    apiVersion: 'qos-binding/v1', kind: 'Application', metadata: { name: 'checkout-app' },
    spec: { tasks: { authenticate: 'auth', inventory: 'stock', shipping: { kind: 'service', requires: { type: 'shipping' } }, notify: { kind: 'local' } }, features: {}, workflow: {} },
  },
  catalog: {
    apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', metadata: { name: 'providers-eu' },
    spec: {
      featureBindings: {},
      candidates: {
        a1: { provides: 'auth', features: {} }, a2: { provides: { type: 'auth' }, features: {} },
        s1: { provides: 'stock', features: {} }, s2: { provides: ['stock', 'shipping'], features: {} }, s3: { provides: 'shipping', features: {} },
      },
    },
  },
  rules: {
    apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', metadata: { name: 'sla' },
    spec: { constraints: [{ assert: {}, enforcement: 'hard' }, { assert: {}, enforcement: 'soft', penalty: {} }] },
  },
  goal: {
    apiVersion: 'qos-binding/v1', kind: 'Optimization', metadata: { name: 'goal' },
    spec: { criteria: [{ id: 'cost', feature: { resource: 'app', id: 'cost' } }, { id: 'latency', feature: { resource: 'app', id: 'latency' } }] },
  },
};
