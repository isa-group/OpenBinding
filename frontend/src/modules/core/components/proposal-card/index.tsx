// Adapted from SPHERE frontend/src/modules/orbit/components/plan-card.tsx (revision 73779a8a, blob fa103561),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an OpenBinding proposal (F6, plan §8) instead of an ORBIT plan, and a core component (the proposal, a diff
// renderer and callbacks; no domain import), so the composition module mounts it now and F7's ORBIT chat mounts the same
// file. Kept from SPHERE: the status pill with its labels and styles for every status (plus "Out of date" for `stale`),
// the source chip (the web; an assistant through MCP; the chat), the summary, the progress bar and "Step i of n" /
// "n of m steps done · failed · skipped", "Review before confirming", the collapsible step list with `StepIcon` and each
// step's error line, the typed phrase with SPHERE's normalisation, and Cancel / "Confirm and apply". Not ported: SPHERE's
// organization tree (`plan-tree.ts`), the file rows and invitation links; the steps render as a list. Added: each step's
// base in words and a part decided by an earlier step said as such, never as a value; for a step with a stored preview,
// "Compare with the version in effect" (the gateway's diff, drawn by the renderer the caller passes) and "Show the
// document"; a done step's link to what it made. Every "Plan" a person reads became "Proposal".

import { motion } from 'framer-motion';
import { useState, type ReactNode } from 'react';
import { MdPublic, MdSmartToy, MdWarningAmber } from 'react-icons/md';
import type { ProposalStepView, ProposalView } from '../../api/types';
import { normalisePhrase } from './phrase';
import { Collapsible, StepItem, type StepLink } from './steps';

export type { StepLink };

type Status = ProposalView['status'];

const STATUS_LABELS: Record<Status, string> = {
  pending: 'Waiting for your confirmation',
  executing: 'Applying…',
  completed: 'Applied',
  partial: 'Partly applied',
  failed: 'Not applied',
  cancelled: 'Cancelled',
  superseded: 'Replaced by a newer proposal',
  stale: 'Out of date',
};

const STATUS_STYLES: Record<Status, string> = {
  pending: 'bg-tp-cream text-tp-primary',
  executing: 'bg-tp-severity-info-bg text-tp-severity-info',
  completed: 'bg-tp-severity-success-bg text-tp-severity-success',
  partial: 'bg-tp-severity-warning-bg text-tp-severity-warning',
  failed: 'bg-tp-severity-error-bg text-tp-severity-error',
  cancelled: 'bg-tp-hairline-soft text-tp-steel',
  superseded: 'bg-tp-hairline-soft text-tp-steel',
  stale: 'bg-tp-hairline-soft text-tp-steel',
};

const SOURCES: Record<ProposalView['origin'], { label: string; icon: ReactNode }> = {
  web: { label: 'From the web', icon: <MdPublic size={12} aria-hidden="true" /> },
  mcp: { label: 'From an assistant (MCP)', icon: <MdSmartToy size={12} aria-hidden="true" /> },
  chat: { label: 'From the chat', icon: <MdSmartToy size={12} aria-hidden="true" /> },
};

export interface ProposalCardProps {
  proposal: ProposalView;
  /** The ordinal of the step being applied right now, while the proposal runs. */
  runningStep?: number | null;
  /** A confirmation or a cancellation is on its way: the buttons wait. */
  busy?: boolean;
  /** Confirm (the author only); `confirmation` is the typed phrase, when one is required. */
  onConfirm?: (proposal: ProposalView, confirmation?: string) => void;
  onCancel?: (proposal: ProposalView) => void;
  /** Draws the gateway's diff of a step's stored document against the version in effect (the version-diff view). */
  renderDiff?: (diff: Record<string, unknown>, step: ProposalStepView) => ReactNode;
  /** A step's base in words ("Production as it was, with 1.0.0 in effect"); the card's own words without it. */
  describeBase?: (step: ProposalStepView) => string | null;
  /** Where a done step's result opens (the sealed version compared in Versions, the environment adopted in). */
  resultLink?: (step: ProposalStepView) => StepLink | null;
  /** Draws a seal step's stored document (the platform's source view); without it the document is not offered. */
  renderDocument?: (document: string, step: ProposalStepView) => ReactNode;
  /** What the caller says under the card: why a confirmation was refused, what to do next. */
  notice?: ReactNode;
}

function countSteps(steps: ProposalStepView[]) {
  return {
    total: steps.length,
    done: steps.filter(step => step.status === 'done').length,
    failed: steps.filter(step => step.status === 'failed').length,
    skipped: steps.filter(step => step.status === 'skipped').length,
  };
}

/** One proposal: what it does, step by step, and, while it waits for its author, Confirm and Cancel. */
export function ProposalCard({
  proposal,
  runningStep = null,
  busy = false,
  onConfirm,
  onCancel,
  renderDiff,
  describeBase,
  resultLink,
  renderDocument,
  notice,
}: ProposalCardProps) {
  const counts = countSteps(proposal.steps);
  const [showSteps, setShowSteps] = useState(proposal.status === 'pending');
  const [typed, setTyped] = useState('');
  const phrase = proposal.confirmationPhrase ?? null;
  // Proposals that are hard to undo wait until their author has typed what they name.
  const phraseMatches = !phrase || normalisePhrase(typed) === normalisePhrase(phrase);
  const inactive = ['cancelled', 'superseded', 'stale'].includes(proposal.status);
  const finished = ['completed', 'partial', 'failed'].includes(proposal.status);
  const executing = proposal.status === 'executing';
  const progress = executing ? counts.done + counts.failed + counts.skipped : counts.total;
  const actionable = proposal.status === 'pending' && proposal.mine && (onConfirm || onCancel);
  const source = SOURCES[proposal.origin];
  const destructive = proposal.steps.some(step => step.destructive);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      aria-label={`Proposal: ${proposal.summary}`}
      role="group"
      className={`w-full min-w-0 overflow-hidden rounded-2xl border border-tp-hairline bg-tp-canvas text-left shadow-elevation-2 ${inactive ? 'opacity-70' : ''}`}
    >
      <div className="border-b border-tp-hairline-soft bg-tp-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-tp-steel uppercase">
            Proposal
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[proposal.status]}`}
          >
            {STATUS_LABELS[proposal.status]}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-tp-hairline-soft px-2 py-0.5 text-[11px] text-tp-slate">
            {source.icon} {source.label}
          </span>
          {proposal.proposedBy && !proposal.mine && (
            <span className="text-[11px] text-tp-steel">{`By ${proposal.proposedBy.username}`}</span>
          )}
        </div>
        <p className="mt-1.5 text-[13px] font-medium [overflow-wrap:anywhere] text-tp-ink">
          {proposal.summary}
        </p>
      </div>

      {(executing || finished) && (
        <div className="px-4 pt-3">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-tp-hairline-soft"
            role="progressbar"
            aria-label="Steps applied"
            aria-valuemin={0}
            aria-valuemax={counts.total}
            aria-valuenow={progress}
          >
            <motion.div
              className={`h-full ${counts.failed > 0 ? 'bg-tp-severity-warning' : 'bg-tp-primary'}`}
              initial={false}
              animate={{ width: `${counts.total ? (progress / counts.total) * 100 : 0}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-tp-steel" aria-live="polite">
            {executing
              ? `Step ${Math.min(progress + 1, counts.total)} of ${counts.total}`
              : `${counts.done} of ${counts.total} steps done${counts.failed ? ` · ${counts.failed} failed` : ''}${counts.skipped ? ` · ${counts.skipped} skipped` : ''}`}
          </p>
          {(proposal.status === 'partial' || proposal.status === 'failed') && (
            <p className="mt-1 text-[11px] text-tp-slate">
              {counts.done > 0
                ? 'What is done stays done; nothing else was changed.'
                : 'Nothing was changed.'}
            </p>
          )}
        </div>
      )}

      {proposal.warnings.length > 0 && (
        <div className="mx-4 mt-3 rounded-xl border border-tp-severity-warning-border bg-tp-severity-warning-bg px-3 py-2">
          <p className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-tp-severity-warning">
            <MdWarningAmber size={14} aria-hidden="true" /> Review before confirming
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-tp-ink-tint">
            {proposal.warnings.map(warning => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <Collapsible
          open={showSteps || executing}
          onToggle={() => setShowSteps(open => !open)}
          label={`${counts.total} step${counts.total === 1 ? '' : 's'}`}
        >
          <ol aria-label="Steps" className="m-0 list-none space-y-2 p-0">
            {proposal.steps.map(step => (
              <StepItem
                key={step.ordinal}
                step={step}
                running={executing && runningStep === step.ordinal}
                renderDiff={renderDiff}
                describeBase={describeBase}
                resultLink={resultLink}
                renderDocument={renderDocument}
              />
            ))}
          </ol>
        </Collapsible>
      </div>

      {notice && <div className="border-t border-tp-hairline-soft px-4 py-3">{notice}</div>}

      {actionable && phrase && (
        <div className="border-t border-tp-hairline-soft px-4 py-3">
          <label htmlFor={`confirm-${proposal.id}`} className="block text-[12px] text-tp-slate">
            {destructive ? 'This cannot be undone.' : 'This cannot be undone by you.'} Type{' '}
            <strong className="text-tp-ink">{phrase}</strong> to confirm.
          </label>
          <input
            id={`confirm-${proposal.id}`}
            value={typed}
            onChange={event => setTyped(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && phraseMatches && !busy) onConfirm?.(proposal, typed);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder={phrase}
            className="mt-1.5 w-full rounded-lg border border-tp-hairline bg-tp-canvas px-2.5 py-1.5 text-[13px] text-tp-ink transition-colors outline-none placeholder:text-tp-muted focus:border-tp-primary/60"
          />
        </div>
      )}
      {actionable && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-tp-hairline-soft bg-tp-surface px-4 py-3">
          {onCancel && (
            <button
              type="button"
              onClick={() => onCancel(proposal)}
              disabled={busy}
              className="min-h-8 cursor-pointer rounded-lg border border-tp-hairline px-3 py-1.5 text-[12px] font-medium text-tp-slate transition-colors hover:bg-tp-hairline-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          {onConfirm && (
            <button
              type="button"
              onClick={() => onConfirm(proposal, phrase ? typed : undefined)}
              disabled={busy || !phraseMatches}
              className={`min-h-8 cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                destructive
                  ? 'bg-tp-severity-error text-white hover:bg-red-600'
                  : 'bg-tp-primary text-tp-on-primary hover:bg-tp-primary-deep'
              }`}
            >
              {destructive ? 'Delete permanently' : 'Confirm and apply'}
            </button>
          )}
        </div>
      )}
      {proposal.status === 'pending' && !proposal.mine && (
        <p className="m-0 border-t border-tp-hairline-soft px-4 py-3 text-[12px] text-tp-steel">
          {`Only ${proposal.proposedBy?.username ?? 'its author'} can confirm or cancel it.`}
        </p>
      )}
    </motion.div>
  );
}
