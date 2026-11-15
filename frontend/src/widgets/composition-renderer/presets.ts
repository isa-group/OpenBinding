import type { Mode } from '../../entities/composition/viewModel';

/**
 * The renderer's presentation presets (A-5): which sections each mode shows, in which order. Like pricing-renderer's `catalog`
 * and `commercial`, they live in code, never in the document or on the composition; a screen narrows them with `hideSections`.
 */

/** The modes this renderer draws so far; the others join with the blocks that build them. */
export type RendererMode = Extract<Mode, 'catalog'>;

/**
 * The sections of the catalog: who the composition is, how far its values can be trusted, the values, what each task is
 * bound to, the composition's own pricing, how the values were obtained, the problem it links, and what the evaluation found.
 */
export type Section = 'identity' | 'status' | 'values' | 'binding' | 'offering' | 'evidence' | 'problem' | 'diagnostics';

export const MODE_SECTIONS: Readonly<Record<RendererMode, readonly Section[]>> = {
  catalog: ['identity', 'status', 'values', 'binding', 'offering', 'evidence', 'problem', 'diagnostics'],
};

/** How tightly a mode is laid out: a page of its own, or a panel beside something else. */
export type Density = 'comfortable' | 'compact';

/** The sections a mode shows, without the ones a screen hides. */
export function sectionsOf(mode: RendererMode, hidden: readonly Section[] = []): Section[] {
  return MODE_SECTIONS[mode].filter((section) => !hidden.includes(section));
}
