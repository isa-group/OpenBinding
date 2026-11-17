// Pattern only, after SPHERE frontend/src/modules/organization/pages/organization-detail/constants.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's role pill recipe (rounded-full, small text, a tinted border) carries OpenBinding's
// run states and outcomes; a gateway refusal is said in SPHERE's notice with its way forward.

import type { ReactNode } from 'react';
import { Action } from '../../../core/components/action-button';
import { Chip } from '../../../core/components/chip';
import { Notice } from '../../../core/components/notice';
import { jobStatus, normalizeStatus, outcomeOf, type JobTone } from '../../utils/runsModel';
import type { Refusal } from '../../utils/runErrors';

const PILL: Record<JobTone, string> = {
  running: 'border-sky-200 bg-sky-50 text-sky-800',
  queued: 'border-tp-hairline-strong bg-tp-surface text-tp-slate',
  ok: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warn: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
  bad: 'border-tp-severity-error-border bg-tp-severity-error-bg text-tp-error-text',
  off: 'border-tp-hairline bg-tp-surface text-tp-steel',
};

const DOT: Record<JobTone, string> = {
  running: 'bg-sky-500 animate-pulse motion-reduce:animate-none',
  queued: 'bg-tp-stone',
  ok: 'bg-tp-severity-success',
  warn: 'bg-tp-severity-warning',
  bad: 'bg-tp-severity-error',
  off: 'bg-tp-muted',
};

/** Where a run stands: a dot and a word in a pill, coloured by how it went. */
export function StatusChip({
  status,
  termination,
}: {
  status: string;
  termination?: string | null;
}) {
  const state = normalizeStatus(status);
  const shown = jobStatus(state, state === 'completed' ? null : termination);
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-tight font-semibold whitespace-nowrap ${PILL[shown.tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[shown.tone]}`} aria-hidden="true" />
      {shown.label}
    </span>
  );
}

/** How a finished run ended, in words. */
export function OutcomeChip({
  termination,
  long = false,
}: {
  termination?: string | null;
  long?: boolean;
}) {
  const outcome = outcomeOf(termination);
  if (!outcome)
    return (
      <span className="text-tp-steel" aria-label="No outcome yet">
        —
      </span>
    );
  return <Chip tone={outcome.tone}>{long ? outcome.long : outcome.label}</Chip>;
}

/** A refusal of the gateway, worded: the title, what it means, the lines it attached, and the way forward. */
export function RefusalNotice({
  refusal,
  action,
  usageTo,
  extra,
}: {
  refusal: Refusal;
  action?: ReactNode;
  usageTo?: boolean;
  extra?: ReactNode;
}) {
  return (
    <Notice
      tone={
        refusal.kind === 'plan' || refusal.kind === 'key' || refusal.kind === 'terminal'
          ? 'warning'
          : 'error'
      }
      title={refusal.title}
      action={action}
    >
      {refusal.text}
      {refusal.permission && refusal.kind === 'key' && (
        <>
          {' '}
          <Chip mono>{refusal.permission}</Chip>
        </>
      )}
      {refusal.details.map(line => (
        <span className="block text-xs [overflow-wrap:anywhere]" key={line}>
          {line}
        </span>
      ))}
      {extra}
      {refusal.kind === 'range' && (
        <span className="mt-1 flex flex-wrap gap-3">
          <Action to="/engines" variant="link" size="sm">
            Engines
          </Action>
        </span>
      )}
      {/* A larger plan helps with an allowance or a job limit of the plan - not with a limit this deployment sets whatever
          the plan (the problem size, the study matrix), nor with one the plan can't apply (`misconfigured`). */}
      {usageTo &&
        (refusal.kind === 'quota' ||
          (refusal.kind === 'busy' && refusal.source !== 'technical') ||
          refusal.kind === 'plan') && (
          <span className="mt-1 flex flex-wrap gap-3">
            <Action to="/me/settings?section=plan" variant="link" size="sm">
              See your plan
            </Action>
            <Action to="/pricing" variant="link" size="sm">
              Compare plans
            </Action>
          </span>
        )}
    </Notice>
  );
}
