import type { CompositionViewModel } from '../../entities/composition/viewModel';
import { CatalogMode } from './modes/catalog';
import { sectionsOf, type Density, type RendererMode, type Section } from './presets';
import './CompositionRenderer.css';

export interface RendererLinks {
  /** Where the linked problem opens, for a reader who may open it; without it the problem is named as text. */
  problemHref?: string | null;
  /** Where a run opens, for a reader who may open it; without it a run is named as text. */
  runHref?: ((run: string) => string | null) | null;
}

interface CompositionRendererProps extends RendererLinks {
  model: CompositionViewModel;
  mode: RendererMode;
  /** Sections of the mode's preset this screen does not show (the page header already names the composition, say). */
  hideSections?: readonly Section[];
  density?: Density;
}

/**
 * A composition drawn in one mode, from its view-model. Which sections a mode shows comes from its preset (`presets.ts`), and
 * the screen chooses the rest by props: nothing about the presentation is read from or written to the document.
 */
export function CompositionRenderer({ model, mode, hideSections = [], density = 'comfortable', problemHref = null, runHref = null }: CompositionRendererProps) {
  const sections = sectionsOf(mode, hideSections);
  return (
    <div className={`cr is-${density}`} data-mode={mode}>
      {mode === 'catalog' && <CatalogMode model={model} sections={sections} problemHref={problemHref} runHref={runHref} />}
    </div>
  );
}
