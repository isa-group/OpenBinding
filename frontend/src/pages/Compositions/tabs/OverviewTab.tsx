import { Action } from '../../../components/ui/Action';
import { Notice } from '../../../components/ui/Notice';
import type { CompositionViewModel } from '../../../entities/composition/viewModel';
import { problemPath } from '../../../routes/paths/problems';
import { runPath } from '../../../routes/paths/runs';
import type { CompositionVersionView } from '../../../shared/api/types';
import { CompositionRenderer } from '../../../widgets/composition-renderer/CompositionRenderer';

/** Where the candidates of the linked problem stand, when the version links one the member may read. */
export interface CandidatesState {
  status: 'loading' | 'error';
  /** Why they could not be read, as a marker for the message (` (503)`). */
  marker: string;
  retry: () => void;
}

/**
 * Overview: the composition in `catalog` mode, then its `architecture` (who serves it) and its `workflow` (how its tasks run,
 * with the linked problem's candidates for a member). The page header already names it, so the catalog leaves its identity
 * out; the problem and the runs it names open for a member.
 */
export function OverviewTab({ org, model, version, candidates = null }: {
  org: string; model: CompositionViewModel; version: CompositionVersionView | null; candidates?: CandidatesState | null;
}) {
  const link = version?.problem ?? null;
  const problemHref = link && model.status.problemReadable
    ? problemPath(org, link.problem.slug, undefined, { version: link.revision.revision })
    : null;
  return (
    <div className="cmp-overview">
      <CompositionRenderer
        model={model}
        mode="catalog"
        hideSections={['identity']}
        problemHref={problemHref}
        runHref={model.reader === 'member' ? (run) => runPath(org, run) : null}
      />
      {model.version && (
        <>
          <CompositionRenderer model={model} mode="architecture" />
          <CompositionRenderer model={model} mode="workflow" />
          {candidates?.status === 'loading' && <p className="cmp-muted" role="status">Loading the candidates of the linked problem…</p>}
          {candidates?.status === 'error' && (
            <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={candidates.retry}>Retry</Action>}>
              {`The candidates of the linked problem couldn’t be loaded${candidates.marker}.`}
            </Notice>
          )}
        </>
      )}
    </div>
  );
}
