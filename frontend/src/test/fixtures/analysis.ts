import type { CompositionMove, CompositionNeighborhoodResponse, CompositionVersionView, CompositionView, EvaluateResult } from '../../shared/api/types';
import fmsVersion from './core/fms.version.json';

// The analysis of the FMS fixture version (core/fms.version.json, linked to the problem fms@1): the toolchain's one-task moves of
// its binding as the gateway answers `neighborhood`, and another binding as it answers `evaluate`. The numbers are illustrative;
// screens show them as given.

export const FMS_COMPOSITION: CompositionView = {
  id: 'composition-fms', slug: 'fleet-routing', name: 'Fleet routing', description: '', kind: 'workflow', archived: false, visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' }, created_by_id: null, created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z', version_count: 1,
  latest_version: { id: fmsVersion.id, ordinal: 1, label: '1.0.0', values_status: 'verified', verified: true, created_at: '2026-10-01T00:00:00Z' },
};

/** The fixture version, as `include=document` serves it. */
export const fmsVersionView = (): CompositionVersionView => structuredClone(fmsVersion) as CompositionVersionView;

function move(task: string, from: string, to: string, over: Partial<CompositionMove>): CompositionMove {
  return {
    task, candidate: to, from: { resource: 'catalog', id: from }, to: { resource: 'catalog', id: to },
    decision: { kind: 'binding' }, objectives: {}, feasible: true, comparison: 'equal', componentDeltas: [], penaltyDelta: 0, violations: [],
    ...over,
  };
}

/** Three moves in the gateway's order (T6, T1, T2): a trade-off, an improvement, and one that breaks a hard rule. */
export const NEIGHBOURHOOD: CompositionNeighborhoodResponse = {
  version: { id: fmsVersion.id, label: fmsVersion.label },
  kind: 'canonical-one-task-counterfactuals',
  irDigest: `sha256-${'c'.repeat(64)}`,
  scope: 'all-service-tasks',
  task: null,
  base: {},
  moves: [
    move('T6', 'cand_t6_paypal', 'cand_t6_stripe', {
      comparison: 'trade-off',
      componentDeltas: [{ feature: 'cost', value: 15, loss: 0.01 }, { feature: 'execution_time', value: -40, loss: -0.02 }],
    }),
    move('T1', 'cand_t1_aws', 'cand_t1_google_cloud', {
      comparison: 'better',
      componentDeltas: [{ feature: 'cost', value: -20, loss: -0.015 }, { feature: 'execution_time', value: 10, loss: 0.001 }],
    }),
    move('T2', 'cand_t2_radius_iot_network', 'cand_t2_samsara_fleet_api', {
      comparison: 'infeasible', feasible: false, penaltyDelta: 5,
      componentDeltas: [{ feature: 'cost', value: 40, loss: 0.03 }],
      violations: [{ constraint: { resource: 'rules', id: 'eu-only' }, enforcement: 'hard', penalty: 5, message: 'Keep the data in the EU' }],
    }),
  ],
  failures: [],
  coverage: { total: 5, attempted: 3, evaluated: 3, complete: false, limit: 64, stopReason: 'time-budget', perTask: { T1: 1, T2: 1, T3: 1, T5: 1, T6: 1 } },
  conclusion: 'Found 1 feasible canonical improvements or feasibility repairs. Coverage is incomplete; unchecked or failed moves may improve the binding.',
  semantics: 'Re-evaluated with the current canonical evaluator.',
};

/** T1 bound to Google Cloud, as `evaluate` answers it. */
export const EVALUATED: EvaluateResult = {
  version: { id: fmsVersion.id, label: fmsVersion.label },
  valid: true,
  values: {
    availability: { value: 0.9966034884802901, unit: '1' },
    cost: { value: 3080, unit: 'USD/month' },
    execution_time: { value: 3190, unit: 'ms' },
    reliability: { value: 0.9771952373591039, unit: '1' },
    security: { value: 4, unit: 'score' },
  },
  violations: [],
  diagnostics: [],
};
