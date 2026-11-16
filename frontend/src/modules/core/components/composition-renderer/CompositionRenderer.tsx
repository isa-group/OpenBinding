import type { CompositionViewModel } from '../../utils/composition/viewModel';
import type { AnalysisActions } from './modes/analysis';
import { ArchitectureMode } from './modes/architecture';
import { CalculatorMode } from './modes/calculator';
import { CatalogMode } from './modes/catalog';
import { Comparison, type ComparisonData } from './modes/comparison/Comparison';
import { ConfiguratorMode } from './modes/configurator';
import { ShowcaseMode, type ShowcaseActions } from './modes/showcase';
import { WorkflowMode } from './modes/workflow';
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
  /**
   * Show only what differs between two versions: in the comparison mode the file view starts with the unchanged lines folded
   * (the structured view lists only changes either way). Without it every line shows at first.
   */
  onlyDifferences?: boolean;
  /** The pair the comparison mode compares and what the gateway answered for it; `model` is then the later version's. */
  comparison?: ComparisonData;
  /** The page's answers to the calculator and the configurator (try, derive, open as a draft), and where the configurator starts. */
  analysis?: AnalysisActions;
  /** The public page's versions, permalink and links, and its answer to Fork (the page mounts the dialog). */
  showcase?: ShowcaseActions;
}

/**
 * A composition drawn in one mode, from its view-model. Which sections a mode shows comes from its preset (`presets.ts`), and
 * the screen chooses the rest by props: nothing about the presentation is read from or written to the document.
 */
export function CompositionRenderer({
  model,
  mode,
  hideSections = [],
  density = 'comfortable',
  onlyDifferences = true,
  comparison,
  analysis,
  showcase,
  problemHref = null,
  runHref = null,
}: CompositionRendererProps) {
  const sections = sectionsOf(mode, hideSections);
  return (
    <div className={`cr is-${density}`} data-mode={mode}>
      {mode === 'catalog' && (
        <CatalogMode
          model={model}
          sections={sections}
          problemHref={problemHref}
          runHref={runHref}
        />
      )}
      {mode === 'architecture' && <ArchitectureMode model={model} sections={sections} />}
      {mode === 'workflow' && <WorkflowMode model={model} sections={sections} />}
      {mode === 'comparison' && comparison && (
        <Comparison
          {...comparison}
          model={model}
          sections={sections}
          onlyDifferences={onlyDifferences}
        />
      )}
      {mode === 'calculator' && (
        <CalculatorMode model={model} sections={sections} actions={analysis} />
      )}
      {mode === 'configurator' && (
        <ConfiguratorMode model={model} sections={sections} actions={analysis} />
      )}
      {mode === 'showcase' && <ShowcaseMode model={model} sections={sections} actions={showcase} />}
    </div>
  );
}
