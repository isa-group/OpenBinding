// Pattern only, after SPHERE frontend/src/modules/orbit/hooks/useOrbitChat.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in
// THIRD_PARTY_NOTICES.md.
// One proposal as the composition screens show it (F6): the core proposal card with the composition's words (a step's
// base, where a done step's result opens), the version-diff view drawing each seal step's stored diff, and the author's
// Confirm and Cancel. Confirming marks the proposal `executing` at once (as SPHERE's ORBIT chat does), then shows the
// gateway's final proposal; a refusal is said under the card, and a proposal that changed meanwhile is read again.

import { useState } from 'react';
import type { CompositionVersionDiff, ProposalView } from '../../../core/api/types';
import { ProposalCard } from '../../../core/components/proposal-card';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import { useProposalsApi } from '../../api/proposalsApi';
import {
  describeBase,
  proposalRefusal,
  resultLink,
  type ProposalContext,
  type ProposalRefusal,
} from '../../utils/proposals';
import { SourceView } from '../../../run/components/rendering/SourceView';
import { DiffResult } from '../version-diff';

/** The gateway's diff of a seal step's document, drawn by the Versions tab's structured comparison. */
function StepDiff({ diff }: { diff: Record<string, unknown> }) {
  const [filter, setFilter] = useState<'added' | 'removed' | 'changed' | null>(null);
  return (
    <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-tp-hairline p-3">
      <DiffResult
        diff={diff as unknown as CompositionVersionDiff}
        filter={filter}
        onFilterChange={setFilter}
        workflow={null}
      />
    </div>
  );
}

interface Props {
  proposal: ProposalView;
  context: ProposalContext;
  /** The proposal changed (confirmed, cancelled, refused as out of date): the screen reads what it shows again. */
  onChanged?: (proposal: ProposalView | null) => void;
}

export default function ProposalPanel({ proposal: given, context, onChanged }: Props) {
  const api = useProposalsApi();
  const { addToast } = useToast();
  const [shown, setShown] = useState<{ from: string; now: ProposalView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ProposalRefusal | null>(null);
  // What the card shows: the proposal given, or what happened to it here, until the screen gives this proposal in
  // another status (a read made after what happened here).
  const givenKey = `${given.id}:${given.status}`;
  const proposal = shown && shown.from === givenKey ? shown.now : given;
  const show = (now: ProposalView) => setShown({ from: givenKey, now });

  const reread = async () => {
    try {
      const read = await api.get(context.org, given.id);
      show(read);
      onChanged?.(read);
    } catch {
      onChanged?.(null);
    }
  };

  const confirm = async (target: ProposalView, confirmation?: string) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    show({ ...target, status: 'executing' });
    try {
      const final = await api.confirm(context.org, target.id, confirmation);
      show(final);
      addToast({
        kind: SYSTEM_TOAST,
        title:
          final.status === 'completed'
            ? 'The proposal was applied.'
            : final.status === 'partial'
              ? 'The proposal was partly applied.'
              : 'The proposal was not applied.',
      });
      onChanged?.(final);
    } catch (caught) {
      show(target);
      const said = proposalRefusal(caught, context, target.steps);
      setRefusal(said);
      if (said.reread) await reread();
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (target: ProposalView) => {
    if (busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      const final = await api.cancel(context.org, target.id);
      show(final);
      addToast({ kind: SYSTEM_TOAST, title: 'The proposal was cancelled. Nothing was changed.' });
      onChanged?.(final);
    } catch (caught) {
      const said = proposalRefusal(caught, context, target.steps);
      setRefusal(said);
      if (said.reread) await reread();
    } finally {
      setBusy(false);
    }
  };

  const executing = proposal.status === 'executing';
  const running = executing
    ? (proposal.steps.find(step => step.status === 'pending')?.ordinal ?? null)
    : null;
  const against =
    proposal.steps.find(step => step.preview?.against)?.preview?.against?.version.label ?? null;

  return (
    <ProposalCard
      proposal={proposal}
      runningStep={running}
      busy={busy}
      onConfirm={(target, confirmation) => void confirm(target, confirmation)}
      onCancel={target => void cancel(target)}
      renderDiff={diff => <StepDiff diff={diff} />}
      renderDocument={(document, step) => (
        <SourceView
          source={document}
          label={`The document step ${step.ordinal} seals`}
          language="yaml"
          maxHeight="18rem"
        />
      )}
      describeBase={step => describeBase(context, step)}
      resultLink={step => resultLink(context, step, against)}
      notice={
        refusal ? (
          <p role="alert" className="m-0 text-[12px] text-tp-severity-error">
            {refusal.text}
          </p>
        ) : null
      }
    />
  );
}
