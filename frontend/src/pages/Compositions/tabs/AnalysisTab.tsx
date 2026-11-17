import '../Compositions.css';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Action } from '../../../modules/core/components/action-button';
import { Notice } from '../../../modules/core/components/notice';
import { compositionsApi } from '../../../modules/core/utils/composition/api';
import type { CompositionViewModel } from '../../../modules/core/utils/composition/viewModel';
import { DeriveCompositionDialog } from '../../../modules/run/components/derive/DeriveCompositionDialog';
import { bindingDerivation, nextMinor } from '../../../modules/run/components/derive/deriveModel';
import { compositionPath } from '../../../routes/paths/compositions';
import { readApiError } from '../../../modules/core/api/errors';
import type { CompositionView } from '../../../modules/core/api/types';
import { compositionFragment } from '../../../modules/core/utils/sphere/composition-fragment';
import { CompositionRenderer } from '../../../modules/core/components/composition-renderer/CompositionRenderer';
import {
  NOT_LINKED,
  type AnalysisActions,
  type BindingDerivation,
  type WrittenBinding,
} from '../../../modules/core/components/composition-renderer/modes/analysis';

interface AnalysisTabProps {
  org: string;
  composition: CompositionView;
  model: CompositionViewModel;
  /** Derive versions and open drafts: MEMBER. Reading the moves and evaluating bindings is open to every reader of the organization. */
  canDerive: boolean;
  /** Where the candidates of the linked problem stand, while they are not there. */
  /** Where the candidates of the linked problem stand, while they are not ready. */
  candidates?: { status: 'loading' | 'error'; marker: string; retry: () => void } | null;
  /** The gateway says the shown version links no problem after all: the page hides the tab. */
  onNotLinked: () => void;
}

/**
 * Analysis: the shown version's binding explored on the problem it links, through the gateway only. "One change at a time" is the
 * `calculator` (the toolchain's one-task moves), "Choose per task" the `configurator` (any binding, evaluated). A move or a chosen
 * binding can be tried in the configurator, derived as a new version of this composition (the derive dialog, MEMBER) or opened in
 * the Editor as a draft (MEMBER). A version that links no problem the reader can read has nothing to explore here.
 */
export function AnalysisTab({
  org,
  composition,
  model,
  canDerive,
  candidates = null,
  onNotLinked,
}: AnalysisTabProps) {
  const navigate = useNavigate();
  const [tried, setTried] = useState<{ binding: WrittenBinding; attempt: number } | null>(null);
  const [deriving, setDeriving] = useState<BindingDerivation | null>(null);
  const [draft, setDraft] = useState<{ busy: boolean; error: string }>({ busy: false, error: '' });
  const configurator = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tried) configurator.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [tried]);

  if (!model.version || !model.modes.includes('calculator')) {
    return (
      <Notice tone="info" title="Nothing to explore here">
        {NOT_LINKED}
      </Notice>
    );
  }

  /** The binding as a draft in the Editor: the document `derive` writes for it, not sealed, under the next minor label. */
  const openDraft = async (source: BindingDerivation) => {
    if (draft.busy) return;
    setDraft({ busy: true, error: '' });
    try {
      const answer = await compositionsApi.derive(
        org,
        composition.slug,
        bindingDerivation(source, nextMinor(composition.latest_version?.label), false)
      );
      if ('version' in answer.result) throw new Error('The gateway sealed a preview.');
      void navigate(
        `${compositionPath(org, composition.slug, 'editor')}${compositionFragment(answer.result.content)}`,
        { viewTransition: true }
      );
    } catch (caught) {
      const error = readApiError(caught);
      const code = error.status
        ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})`
        : '';
      setDraft({
        busy: false,
        error: `The draft couldn’t be written${code}${error.message ? `: ${error.message}` : '.'}`,
      });
    }
  };

  const actions: AnalysisActions = {
    onTry: binding => setTried(now => ({ binding, attempt: (now?.attempt ?? 0) + 1 })),
    onNotLinked,
    ...(canDerive
      ? {
          onDerive: setDeriving,
          onOpenDraft: (source: BindingDerivation) => void openDraft(source),
        }
      : {}),
  };

  return (
    <div className="cmp-analysis">
      {model.status.compilationDrift && (
        <Notice tone="warning" title="Evaluated on another compilation">
          This version’s values were evaluated on a compilation of the problem other than the one it
          links.
        </Notice>
      )}
      <CompositionRenderer model={model} mode="calculator" analysis={actions} />
      <div ref={configurator} className="cmp-analysis-configurator">
        {candidates?.status === 'loading' && (
          <p className="cmp-muted" role="status">
            Loading the candidates of the linked problem…
          </p>
        )}
        {candidates?.status === 'error' && (
          <Notice
            tone="error"
            action={
              <Action variant="secondary" size="sm" onClick={candidates.retry}>
                Retry
              </Action>
            }
          >
            {`The candidates of the linked problem couldn’t be loaded${candidates.marker}.`}
          </Notice>
        )}
        {draft.busy && (
          <p className="cmp-muted" role="status">
            Writing the draft…
          </p>
        )}
        {draft.error && <Notice tone="error">{draft.error}</Notice>}
        <CompositionRenderer
          key={tried?.attempt ?? 0}
          model={model}
          mode="configurator"
          analysis={{ ...actions, start: tried?.binding }}
        />
      </div>
      {deriving && (
        <DeriveCompositionDialog
          org={org}
          source={{ ...deriving, composition }}
          onClose={() => setDeriving(null)}
        />
      )}
    </div>
  );
}
