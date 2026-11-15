import type { CompositionViewModel } from '../../../entities/composition/viewModel';
import { problemPath } from '../../../routes/paths/problems';
import { runPath } from '../../../routes/paths/runs';
import type { CompositionVersionView } from '../../../shared/api/types';
import { CompositionRenderer } from '../../../widgets/composition-renderer/CompositionRenderer';

/**
 * Overview: the composition in `catalog` mode. The page header already names it, so the catalog leaves its identity out; the
 * problem and the runs it names open for a member.
 */
export function OverviewTab({ org, model, version }: { org: string; model: CompositionViewModel; version: CompositionVersionView | null }) {
  const link = version?.problem ?? null;
  const problemHref = link && model.status.problemReadable
    ? problemPath(org, link.problem.slug, undefined, { version: link.revision.revision })
    : null;
  return (
    <CompositionRenderer
      model={model}
      mode="catalog"
      hideSections={['identity']}
      problemHref={problemHref}
      runHref={model.reader === 'member' ? (run) => runPath(org, run) : null}
    />
  );
}
