import type { ImmutableResourceRef } from '../../shared/api/types';
import { RANGE_CODE, RANGE_REFUSAL } from '../../utils/featureRange';
import { isRecord, type Diagnostic } from './documents';

/** The engine modes the analysis of a package lists, and what the editor says about each. */

export interface CompatibleMode {
  engine: ImmutableResourceRef;
  registration: ImmutableResourceRef;
  mode: string;
  compatible: boolean;
  diagnostics?: Diagnostic[];
}

function isImmutableResourceRef(value: unknown): value is ImmutableResourceRef {
  return isRecord(value)
    && typeof value.namespace === 'string'
    && typeof value.name === 'string'
    && typeof value.version === 'string'
    && typeof value.digest === 'string';
}

/** Every engine mode the analysis listed, runnable or not: a row for each. */
export function allModesFromAnalysis(value: unknown): CompatibleMode[] {
  if (!isRecord(value) || !Array.isArray(value.compatibleModes)) return [];
  return value.compatibleModes.filter((item): item is CompatibleMode => isRecord(item)
    && isImmutableResourceRef(item.engine) && isImmutableResourceRef(item.registration) && typeof item.mode === 'string');
}

/** Only the modes the gateway says can run the package. */
export function modesFromAnalysis(value: unknown): CompatibleMode[] {
  return allModesFromAnalysis(value).filter((item) => item.compatible === true);
}

export function executionKey(item: CompatibleMode): string {
  return [
    item.engine.namespace,
    item.engine.name,
    item.engine.version,
    item.engine.digest,
    item.registration.namespace,
    item.registration.name,
    item.registration.version,
    item.registration.digest,
    item.mode,
  ].join('|');
}

export interface EngineRow {
  key: string;
  name: string;
  mode: string;
  runnable: boolean;
  registered: boolean;
  why: string;
}

/** Did the gateway turn the mode down because of ranges (`unsupported_capability_value`, or an interval it can't take)? */
export function refusesRanges(mode: CompatibleMode): boolean {
  return mode.compatible !== true && (mode.diagnostics ?? []).some((diagnostic) => (
    diagnostic.code === RANGE_CODE || /\binterval\b/i.test(`${diagnostic.message ?? ''} ${diagnostic.detail ?? ''}`)
  ));
}

/** The reason a mode that can't run the package gives, in words. A refusal for ranges says so in the one sentence everywhere. */
export function whyNot(mode: CompatibleMode): string {
  if (refusesRanges(mode)) return RANGE_REFUSAL;
  return mode.diagnostics?.map((diagnostic) => diagnostic.message ?? diagnostic.detail).filter(Boolean).join(' ') || 'Its declared capabilities don’t cover this package.';
}

/** A row for each engine mode the analysis listed, with the reason it can or can't run the package. */
export function engineRows(modes: CompatibleMode[]): EngineRow[] {
  return modes.map((item) => ({
    key: `${item.engine.namespace}/${item.engine.name}@${item.engine.version}#${item.registration.name}@${item.registration.version}/${item.mode}`,
    name: `${item.engine.name} ${item.engine.version}`,
    mode: item.mode,
    runnable: item.compatible === true,
    registered: item.engine.namespace !== 'bim.builtin',
    why: item.compatible
      ? `Runs through ${item.registration.namespace}/${item.registration.name}@${item.registration.version}.`
      : whyNot(item),
  }));
}
