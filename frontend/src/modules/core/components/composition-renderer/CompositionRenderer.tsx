import type { RendererUpstream } from '../../utils/composition/upstream';
import type { CompositionViewModel } from '../../utils/composition/viewModel';
import type { AnalysisActions } from './modes/analysis';
import { ArchitectureMode } from './modes/architecture';
import { CatalogMode } from './modes/catalog';
import { ConfiguratorMode } from './modes/configurator';
import { OperationsMode, type OperationsData } from './modes/operations';
import { ShowcaseMode } from './modes/showcase';
import { WorkflowMode } from './modes/workflow';
import { sectionsOf, type Density, type RendererMode, type Section } from './presets';

export interface RendererLinks {
  /** Where the linked problem opens, for a reader who may open it; without it the problem is named as text. */
  problemHref?: string | null;
  /** Where a run opens, for a reader who may open it; without it a run is named as text. */
  runHref?: ((run: string) => string | null) | null;
}

interface CompositionRendererProps extends RendererLinks {
  model: CompositionViewModel;
  /** The comparison's sections are drawn by the version diff (`modes/graph-diff`), not by a mode of the renderer. */
  mode: Exclude<RendererMode, 'comparison'>;
  /** Sections of the mode's preset this screen does not show (the page header already names the composition, say). */
  hideSections?: readonly Section[];
  density?: Density;
  /** The page's answers to the configurator (try, derive, open as a draft), and where it starts. */
  analysis?: AnalysisActions;
  /**
   * The version's upstream plans and offering as the gateway stored them, with their snapshots' YAML: the plan cards and the
   * storefront are drawn from it; without it they keep their reference faces. The page loads it, so core never reads a module.
   */
  upstream?: RendererUpstream | null;
  /** What the `operations` mode draws: an environment's version in effect and the page's slots. */
  operation?: OperationsData;
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
  analysis,
  problemHref = null,
  runHref = null,
  upstream = null,
  operation,
}: CompositionRendererProps) {
  const sections = sectionsOf(mode, hideSections);
  return (
    <div
      className={`cr is-${density} flex min-w-0 flex-col ${density === 'compact' ? 'gap-4' : 'gap-6'}`}
      data-mode={mode}
    >
      {mode === 'catalog' && (
        <CatalogMode
          model={model}
          sections={sections}
          problemHref={problemHref}
          runHref={runHref}
          upstream={upstream}
        />
      )}
      {mode === 'architecture' && (
        <ArchitectureMode model={model} sections={sections} upstream={upstream} />
      )}
      {mode === 'workflow' && <WorkflowMode model={model} sections={sections} />}
      {mode === 'configurator' && (
        <ConfiguratorMode model={model} sections={sections} actions={analysis} />
      )}
      {mode === 'showcase' && (
        <ShowcaseMode model={model} sections={sections} upstream={upstream} />
      )}
      {mode === 'operations' && operation && (
        <OperationsMode sections={sections} operation={operation} />
      )}
    </div>
  );
}
