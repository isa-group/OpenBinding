import type { Mode } from '../../utils/composition/viewModel';

/**
 * The renderer's presentation presets (A-5): which sections each mode shows, in which order. Like pricing-renderer's `catalog`
 * and `commercial`, they live in code, never in the document or on the composition; a screen narrows them with `hideSections`.
 */

/** The modes this renderer draws so far; the others join with the blocks that build them. */
export type RendererMode = Extract<
  Mode,
  | 'catalog'
  | 'architecture'
  | 'workflow'
  | 'comparison'
  | 'configurator'
  | 'showcase'
  | 'operations'
>;

/**
 * The sections of the modes.
 * - catalog: who the composition is, how far its values can be trusted, the values, what each task is bound to, the
 *   composition's own pricing, how the values were obtained, the problem it links, and what the evaluation found;
 * - architecture: the providers the tasks are grouped by, and the upstream SPHERE plans the candidates come from;
 * - workflow: the workflow drawn with each task's candidate, and the candidates of the linked problem;
 * - comparison: what changed between two versions (the gateway's diff), the later workflow with what changed marked, and the
 *   candidates each version chose;
 * - configurator: what the toolchain makes of the binding chosen, and the linked problem's candidates to choose from;
 * - showcase: a composition as its documents say it, for every reader: what it does, its values and how far they can be trusted,
 *   the workflow, the providers and the upstream plans, the problem it links (named, never opened), and its own pricing;
 * - operations: what an environment's feed serves (the version in effect, its binding and the offering version its evaluation
 *   read), the open upstream changes of the version in effect, and the environment's adoption history.
 */
export type Section =
  | 'identity'
  | 'status'
  | 'values'
  | 'binding'
  | 'offering'
  | 'evidence'
  | 'problem'
  | 'diagnostics'
  | 'providers'
  | 'plans'
  | 'graph'
  | 'candidates'
  | 'changes'
  | 'result'
  | 'choice'
  | 'about'
  | 'inEffect'
  | 'events'
  | 'adoptions';

export const MODE_SECTIONS: Readonly<Record<RendererMode, readonly Section[]>> = {
  catalog: [
    'identity',
    'status',
    'values',
    'binding',
    'offering',
    'evidence',
    'problem',
    'diagnostics',
  ],
  architecture: ['providers', 'plans'],
  workflow: ['graph', 'candidates'],
  comparison: ['changes', 'graph', 'candidates'],
  configurator: ['result', 'choice'],
  showcase: ['about', 'status', 'values', 'graph', 'providers', 'plans', 'problem', 'offering'],
  operations: ['inEffect', 'events', 'adoptions'],
};

/** How tightly a mode is laid out: a page of its own, or a panel beside something else. */
export type Density = 'comfortable' | 'compact';

/** The sections a mode shows, without the ones a screen hides. */
export function sectionsOf(mode: RendererMode, hidden: readonly Section[] = []): Section[] {
  return MODE_SECTIONS[mode].filter(section => !hidden.includes(section));
}
