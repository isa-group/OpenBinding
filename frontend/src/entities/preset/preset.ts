import type { ImmutableResourceRef, RunPresetView } from '../../modules/core/api/types';

/**
 * How a run preset reads on screen: its engine, its options and its optimization as written, and why a study cannot take it. Nothing
 * is resolved here: whether the engine, the mode and the options fit a problem is the gateway's answer when a run or a study uses
 * the preset.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The exact engine a preset names, or `null` for a built-in engine named by its name alone. */
export function presetEngineRef(engine: RunPresetView['engine']): ImmutableResourceRef | null {
  return typeof engine === 'string' ? null : engine;
}

/** `random-search 1.0.0`, or the built-in name a preset gives. */
export function presetEngineLabel(engine: RunPresetView['engine']): string {
  return typeof engine === 'string' ? engine : `${engine.name} ${engine.version}`;
}

/** `random-search 1.0.0 · mode sampling` (the engine's default mode when the preset names none). */
export function presetEngineText(preset: Pick<RunPresetView, 'engine' | 'mode'>): string {
  return `${presetEngineLabel(preset.engine)} · ${preset.mode ? `mode ${preset.mode}` : 'default mode'}`;
}

/** The deployment a preset sends its runs to, `namespace/name version`; `null` for the engine's installed one. */
export function presetRegistrationText(registration: RunPresetView['registration']): string | null {
  if (!isRecord(registration) || typeof registration.name !== 'string') return null;
  const namespace = typeof registration.namespace === 'string' ? `${registration.namespace}/` : '';
  const version = typeof registration.version === 'string' ? ` ${registration.version}` : '';
  return `${namespace}${registration.name}${version}`;
}

const OPTION_WORDS: Record<string, string> = {
  time_budget_ms: 'time budget',
  max_evaluations: 'evaluations',
  population_size: 'population',
};

/** `time budget 30 s · iterations 100,000`; `Engine defaults` when it sets none. */
export function presetOptionsText(options: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(options ?? {});
  if (entries.length === 0) return 'Engine defaults';
  return entries
    .map(([name, value]) => {
      const label = OPTION_WORDS[name] ?? name.replace(/[_-]+/g, ' ');
      if (name === 'time_budget_ms' && typeof value === 'number')
        return `${label} ${(value / 1000).toLocaleString('en-US')} s`;
      if (typeof value === 'number') return `${label} ${value.toLocaleString('en-US')}`;
      return `${label} ${typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)}`;
    })
    .join(' · ');
}

/** `SINGLE · weighted-sum` (with its weights); `null` when the preset leaves the optimization to the run. */
export function presetOptimizationText(optimization: RunPresetView['optimization']): string | null {
  if (!isRecord(optimization)) return null;
  const type = typeof optimization.type === 'string' ? optimization.type : '?';
  const scalarization =
    typeof optimization.scalarization === 'string' ? optimization.scalarization : '?';
  const weights = Array.isArray(optimization.weights)
    ? optimization.weights
        .filter(isRecord)
        .map(weight => `${String(weight.criteria)} ${String(weight.value)}`)
    : [];
  return `${type} · ${scalarization}${weights.length ? ` (weights ${weights.join(', ')})` : ''}`;
}

/** A preset that runs on a deployment of its own rather than the engine's installed one. */
export const isFederatedPreset = (preset: Pick<RunPresetView, 'registration'>): boolean =>
  isRecord(preset.registration);

/**
 * Why a study cannot take this preset as one of its engines, in the words of the gateway's refusals (`preset_federated`,
 * `preset_incomplete`), or `null` when it can be offered. The gateway still decides when the study is saved and run.
 */
export function studyPresetRefusal(
  preset: Pick<RunPresetView, 'registration' | 'optimization'>
): string | null {
  if (isFederatedPreset(preset))
    return 'Runs on a federated deployment: presets of federated engines can’t join a study yet.';
  if (!isRecord(preset.optimization)) return 'Names no optimization, which a study engine needs.';
  return null;
}
