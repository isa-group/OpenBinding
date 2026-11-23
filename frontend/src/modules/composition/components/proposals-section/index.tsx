// The proposals of a composition on its Operation tab (F6): the caller's pending one on top, read whole (with each seal
// step's document and its diff) and ready to confirm or cancel; the other pending ones, which only their authors confirm;
// then the recent ones, collapsed. Hidden when the composition has none. SPHERE shows its ORBIT plans in the chat; the
// card is its plan card (core `ProposalCard`), the frame the Operation tab's.

import { useState } from 'react';
import type {
  CompositionVersionView,
  CompositionView,
  ProposalView,
} from '../../../core/api/types';
import { useResource } from '../../../core/hooks/useResource';
import { useProposalsApi } from '../../api/proposalsApi';
import type { ProposalContext } from '../../utils/proposals';
import ProposalPanel from './ProposalPanel';

interface Props {
  org: string;
  composition: CompositionView;
  versions: CompositionVersionView[];
  /** The composition's environments, to name a step's environment. */
  environments: ReadonlyArray<{ id: string; slug: string; name: string }>;
  /** Bumped when something the page did may have changed the proposals. */
  refresh?: string | number;
  /** A proposal was applied or changed here: the tab reads its environments again. */
  onChanged?: () => void;
}

export default function ProposalsSection({
  org,
  composition,
  versions,
  environments,
  refresh = 0,
  onChanged,
}: Props) {
  const api = useProposalsApi();
  const [nonce, setNonce] = useState(0);
  const listed = useResource<ProposalView[]>(
    `composition-proposals:${org}/${composition.slug}:${refresh}:${nonce}`,
    () => api.list(org, composition.slug, { limit: 20 }).catch(() => [])
  );
  const proposals = listed.data ?? listed.stale ?? [];
  // The caller's pending proposal; once it is decided here, it stays on top (with its outcome) until the tab is left.
  const [decided, setDecided] = useState<string | null>(null);
  const mine =
    proposals.find(proposal => proposal.mine && proposal.status === 'pending') ??
    proposals.find(proposal => proposal.id === decided) ??
    null;
  // The caller's pending proposal, read whole: a list carries no preview.
  const full = useResource<ProposalView | null>(
    `composition-proposal:${org}/${mine?.id ?? 'none'}:${refresh}:${nonce}`,
    async () => (mine ? api.get(org, mine.id).catch(() => mine) : null)
  );
  if (proposals.length === 0) return null;
  const others = proposals.filter(
    proposal => proposal.status === 'pending' && proposal.id !== mine?.id
  );
  const recent = proposals.filter(
    proposal => proposal.status !== 'pending' && proposal.id !== mine?.id
  );
  const context: ProposalContext = {
    org,
    composition: composition.slug,
    versionLabel: id => versions.find(version => version.id === id)?.label ?? null,
    environments,
  };
  const changed = (proposal: ProposalView | null) => {
    if (proposal) setDecided(proposal.id);
    setNonce(value => value + 1);
    onChanged?.();
  };

  return (
    <section
      aria-labelledby="proposals-heading"
      className="rounded-xl border border-tp-hairline bg-tp-canvas"
    >
      <div className="border-b border-tp-hairline px-5 py-4">
        <h2 id="proposals-heading" className="font-display text-lg text-tp-ink">
          Proposals
        </h2>
        <p className="m-0 text-xs text-tp-steel">
          Changes waiting for their author’s confirmation, and the ones already decided. Nothing in
          a proposal is applied until its author confirms it.
        </p>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {mine && (
          <ProposalPanel
            proposal={full.data && full.data.id === mine.id ? full.data : mine}
            context={context}
            onChanged={changed}
          />
        )}
        {others.map(proposal => (
          <ProposalPanel key={proposal.id} proposal={proposal} context={context} />
        ))}
        {recent.length > 0 && (
          <details className="group rounded-lg border border-tp-hairline">
            <summary className="flex min-h-9 cursor-pointer items-center px-3 text-xs font-medium text-tp-slate hover:text-tp-ink">
              {`Recent proposals (${recent.length})`}
            </summary>
            <div className="flex flex-col gap-3 p-3">
              {recent.map(proposal => (
                <ProposalPanel key={proposal.id} proposal={proposal} context={context} />
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
