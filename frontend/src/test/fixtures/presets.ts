import type { RunPresetView } from '../../shared/api/types';

// Shared by the tests of the run presets (the settings section, the launcher, the study builder) and the S6a and S7a browser specs:
// three presets of ISA Demo Group. "Fast sampling" can join a study; "Edge deployment" runs on a federated deployment and "No goal"
// names no optimization, so a study cannot take either.

const digestOf = (char: string): string => `sha256-${char.repeat(64)}`;

/** The engine of the job and study fixtures (`fixtures/jobs.ts` ENGINE). */
export const PRESET_ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: digestOf('a') };

export function presetFixture(over: Partial<RunPresetView> = {}): RunPresetView {
  return {
    id: 'preset-fast-sampling',
    organization_id: 'org-isa-demo',
    slug: 'fast-sampling',
    name: 'Fast sampling',
    description: 'Thirty seconds of random search.',
    engine: PRESET_ENGINE,
    registration: null,
    mode: 'sampling',
    options: { time_budget_ms: 30000, iterations: 5000 },
    optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
    created_by_id: 'user-1',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-02T10:00:00Z',
    ...over,
  };
}

export const FEDERATED_PRESET = presetFixture({
  id: 'preset-edge-deployment', slug: 'edge-deployment', name: 'Edge deployment', description: '',
  engine: { namespace: 'edge-lab', name: 'edge-solver', version: '0.3.1', digest: digestOf('e') },
  registration: { namespace: 'edge-lab', name: 'edge-solver-eu', version: '1', digest: digestOf('r') }, mode: 'placement', options: {},
});

export const NO_GOAL_PRESET = presetFixture({
  id: 'preset-no-goal', slug: 'no-goal', name: 'No goal', description: '', optimization: null, options: { iterations: 100 },
});

/** The presets of ISA Demo Group, by name, as `listRunPresets` pages them. */
export function presetPage(presets: RunPresetView[] = [FEDERATED_PRESET, presetFixture(), NO_GOAL_PRESET]) {
  return { presets, total: presets.length, limit: 200, offset: 0 };
}
