import type { EngineCatalogEntry } from '../../api/client';
import type { PresetOptimization, PresetSettings } from '../../modules/run/api/presetsApi';
import { presetEngineLabel } from '../../modules/run/utils/preset';
import type { RunPresetView } from '../../modules/core/api/types';
import { SLUG_PATTERN, slugFromName } from '../../modules/core/utils/slug';

/**
 * The form of a run preset in the organization settings: what it offers (the engines of the catalog and their modes) and what it
 * sends. Only the shape is checked here, as the gateway does when a preset is saved; whether the engine and its options fit a problem
 * is answered when a run or a study uses it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const OPTIMIZATION_TYPES = ['SINGLE', 'MULTI', 'MANY'] as const;
type OptimizationType = (typeof OPTIMIZATION_TYPES)[number];

export interface ModeOption {
  id: string;
  /** The options the mode declares (its options schema). */
  options: string[];
  /** The scalarizations the mode declares, with the objective types each takes. */
  scalarizations: Array<{ id: string; types: string[] }>;
}

export interface EngineOption {
  key: string;
  label: string;
  engine: RunPresetView['engine'];
  modes: ModeOption[];
}

/** `name:random-search` for a built-in name, `namespace/name@version#digest` for an exact engine. */
export const engineKeyOf = (engine: RunPresetView['engine']): string =>
  typeof engine === 'string'
    ? `name:${engine}`
    : `${engine.namespace}/${engine.name}@${engine.version}#${engine.digest}`;

function modeOption(mode: EngineCatalogEntry['modes'][number]): ModeOption {
  const declared = isRecord(mode.capabilities)
    ? (mode.capabilities as unknown as Record<string, unknown>).scalarizations
    : undefined;
  const values =
    isRecord(declared) && Array.isArray(declared.values) ? declared.values.filter(isRecord) : [];
  return {
    id: mode.id,
    options: Object.keys(mode.optionsSchema?.properties ?? {}),
    scalarizations: values
      .filter(item => typeof item.id === 'string')
      .map(item => ({
        id: item.id as string,
        types: Array.isArray(item.objectiveTypes)
          ? item.objectiveTypes.filter((type): type is string => typeof type === 'string')
          : [],
      })),
  };
}

/** Every exact engine of the catalog with its modes, and the engine a preset already names when the catalog does not list it. */
export function engineOptions(
  catalog: readonly EngineCatalogEntry[],
  current?: RunPresetView['engine']
): EngineOption[] {
  const options = catalog.map((entry): EngineOption => {
    const engine = {
      namespace: entry.namespace,
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
    };
    return {
      key: engineKeyOf(engine),
      label: `${entry.name} ${entry.version} · ${entry.namespace}`,
      engine,
      modes: entry.modes.map(modeOption),
    };
  });
  if (current !== undefined && !options.some(option => option.key === engineKeyOf(current))) {
    options.unshift({
      key: engineKeyOf(current),
      label: `${presetEngineLabel(current)} (as the preset names it)`,
      engine: current,
      modes: [],
    });
  }
  return options;
}

export interface PresetDraft {
  name: string;
  /** The address as typed; `null` follows the name. Fixed once the preset exists. */
  slug: string | null;
  description: string;
  engineKey: string;
  /** `''` for the engine's default mode. */
  mode: string;
  /** The options as a JSON object. */
  options: string;
  /** `''` leaves the optimization to the run. */
  optimizationType: '' | OptimizationType;
  scalarization: string;
}

/** The form filled with a preset, or empty for a new one. Weights an optimization carries are kept as they are. */
export function draftOf(preset: RunPresetView | null): PresetDraft {
  const optimization = isRecord(preset?.optimization) ? preset.optimization : null;
  const type =
    optimization && OPTIMIZATION_TYPES.includes(optimization.type as OptimizationType)
      ? (optimization.type as OptimizationType)
      : '';
  return {
    name: preset?.name ?? '',
    slug: preset ? preset.slug : null,
    description: preset?.description ?? '',
    engineKey: preset ? engineKeyOf(preset.engine) : '',
    mode: preset?.mode ?? '',
    options:
      preset && Object.keys(preset.options).length > 0
        ? JSON.stringify(preset.options, null, 2)
        : '',
    optimizationType: type,
    scalarization:
      optimization && typeof optimization.scalarization === 'string'
        ? optimization.scalarization
        : '',
  };
}

export const draftSlug = (draft: PresetDraft): string => draft.slug ?? slugFromName(draft.name);

export type DraftField = 'name' | 'slug' | 'engine' | 'options' | 'optimization';

export interface DraftReading {
  /** What the gateway gets, when every field reads. */
  settings: PresetSettings | null;
  errors: Partial<Record<DraftField, string>>;
}

/** The settings a draft stands for, or what is wrong with each field. `weights` of the preset being edited are kept. */
export function readDraft(
  draft: PresetDraft,
  engines: readonly EngineOption[],
  kept: RunPresetView | null = null
): DraftReading {
  const errors: DraftReading['errors'] = {};
  if (!draft.name.trim()) errors.name = 'Give the preset a name.';
  if (!SLUG_PATTERN.test(draftSlug(draft))) errors.slug = 'Lowercase letters, numbers and hyphens.';
  const engine = engines.find(option => option.key === draft.engineKey);
  if (!engine) errors.engine = 'Choose the engine the preset runs.';
  let options: Record<string, unknown> = {};
  if (draft.options.trim()) {
    try {
      const parsed: unknown = JSON.parse(draft.options);
      if (isRecord(parsed)) options = parsed;
      else errors.options = 'Options are a JSON object, like {"time_budget_ms": 30000}.';
    } catch {
      errors.options = 'Options aren’t valid JSON.';
    }
  }
  let optimization: PresetOptimization | null = null;
  if (draft.optimizationType) {
    if (!draft.scalarization.trim())
      errors.optimization = 'Name the scalarization, or leave the optimization to the run.';
    const weights =
      isRecord(kept?.optimization) && Array.isArray(kept.optimization.weights)
        ? { weights: kept.optimization.weights as PresetOptimization['weights'] }
        : {};
    optimization = {
      type: draft.optimizationType,
      scalarization: draft.scalarization.trim(),
      ...weights,
    };
  }
  if (Object.keys(errors).length > 0 || !engine) return { settings: null, errors };
  return {
    settings: { engine: engine.engine, mode: draft.mode || null, options, optimization },
    errors,
  };
}
