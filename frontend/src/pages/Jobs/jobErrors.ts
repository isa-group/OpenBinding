import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { diagnosticLines } from '../../api/problem';
import { RANGE_CODE } from '../../utils/featureRange';
import {
  COMPLEXITY_CODE, USAGE_UNKNOWN_CODE, complexityText, limitProblemOf, noticeOf, slotsText, usageUnknownText,
} from '../../utils/limitRefusals';
import { limitInfo } from '../../utils/limits';
import { classifyAuthError, marker } from '../Account/accountErrors';

export type JobAction = 'launch' | 'retry' | 'cancel';

export type RefusalKind =
  | 'quota' | 'too-big' | 'busy' | 'plan' | 'key' | 'incompatible' | 'range' | 'not-found' | 'conflict' | 'terminal'
  | 'pricing' | 'session' | 'too-large' | 'unavailable' | 'other'
  // A limit that isn't a plan allowance used up (see `utils/limitRefusals`): the plan doesn't say, this deployment caps it, it couldn't be measured, the plan can't be applied.
  | 'limit-unknown' | 'technical' | 'unmeasured' | 'misconfigured';

/** A diagnostic as one line: what it says and, in brackets, where in the package it points. */
function lineOf(row: unknown): string {
  if (typeof row !== 'object' || row === null) return '';
  const entry = row as Record<string, unknown>;
  const message = typeof entry.message === 'string' ? entry.message : typeof entry.code === 'string' ? entry.code : '';
  const where = typeof entry.pointer === 'string' && entry.pointer !== '' ? entry.pointer : typeof entry.irPath === 'string' ? entry.irPath : '';
  const pointer = where && typeof entry.resource === 'string' && entry.resource !== '' && where === entry.pointer ? `${entry.resource}#${where}` : where;
  return pointer && message ? `${message} (${pointer})` : message || pointer;
}

/** The way it is told when an engine refuses ranges: what happened, what to do, and (in `details`) which candidates the gateway pointed at. */
export function rangeRefusal(diagnostics: unknown, at = '', status?: number, ran = false): Refusal {
  const rows = Array.isArray(diagnostics) ? diagnostics : [];
  return {
    kind: 'range', status, code: RANGE_CODE,
    title: `This engine only accepts single values${at}`,
    text: `This package has range features (a min and a max, open or not), but the engine mode that was chosen only accepts single values, so it refused the run. Choose a mode that declares interval values, or edit those candidates to use single values.${ran ? '' : ' Nothing was started.'}`,
    details: rows.map(lineOf).filter(Boolean).slice(0, 8),
  };
}

/** The refusal behind a job that failed for ranges, or `null` when it failed for something else. */
export function rangeFailureOf(job: { error?: unknown; result?: { code?: unknown; error?: unknown; diagnostics?: unknown } | null }): Refusal | null {
  const mentions = (value: unknown) => typeof value === 'string' && value.includes(RANGE_CODE);
  if (job.result?.code === RANGE_CODE || mentions(job.error) || mentions(job.result?.error)) return rangeRefusal(job.result?.diagnostics, '', undefined, true);
  return null;
}

/** What the gateway's refusal means for a person: a title, a sentence, and the extra lines it sent (diagnostics). */
export interface Refusal {
  kind: RefusalKind;
  title: string;
  text: string;
  /** One line per diagnostic the gateway attached (a 422 says which part of the problem the mode cannot run). */
  details: string[];
  status?: number;
  code?: string;
  /** Seconds until a slot should free up (429). */
  retryAfter?: number;
  /** The limit a 402 or 429 names. */
  limitId?: string;
  /** Whose limit it is when the answer says: `plan`, `technical` (this deployment, whatever the plan) or `none` (not declared). */
  source?: string;
  /** The permission an API key is missing (403). */
  permission?: string;
}

function detailsOf(caught: unknown): string[] {
  return caught instanceof HttpError ? diagnosticLines(caught, 8) : [];
}

function permissionOf(message: string | undefined): string | undefined {
  return message?.match(/\b([a-z]+:[a-z]+)\b/)?.[1];
}

/** The words for each way the gateway can refuse to start, retry or cancel a run. */
export function refusalOf(caught: unknown, action: JobAction = 'launch'): Refusal {
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  const quota = caught instanceof QuotaError ? caught.quota : undefined;
  const nothing = action === 'cancel' ? 'Nothing changed.' : 'Nothing was started.';
  const retry = action === 'retry' ? 'Retry refused: ' : '';
  const base = { status: failure.status, code: failure.code, details: detailsOf(caught) };

  if (failure.status === 401) {
    return { ...base, kind: 'session', title: `Your session ended${at}`, text: 'Log in again; your choices are kept.' };
  }

  const notice = noticeOf(caught);
  const limited = limitProblemOf(caught, nothing, at);
  if (limited) return { ...base, ...limited };

  if (failure.status === 402) {
    const limitId = quota?.limit_id ?? notice?.limit_id;
    const complexity = failure.code === COMPLEXITY_CODE || limitId === 'maxInstanceComplexityLog10';
    if (complexity) {
      return {
        ...base, kind: 'too-big', limitId, source: notice?.source,
        title: `Too big for your plan${at}`,
        text: complexityText(caught, nothing),
      };
    }
    const noun = limitId ? limitInfo(limitId).short : 'allowance';
    const limit = quota?.limit ?? notice?.limit;
    const used = quota?.used ?? notice?.used;
    const spent = limit !== undefined ? `You’ve used ${(used ?? limit).toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} ${noun}.` : `You’ve used all your ${noun}.`;
    return {
      ...base, kind: 'quota', limitId, source: notice?.source,
      title: `${retry}Out of ${noun}${at}`,
      text: `${spent} ${nothing}`,
    };
  }

  if (failure.status === 429) {
    const concurrency = caught instanceof HttpError ? caught.concurrency : undefined;
    return {
      ...base, kind: 'busy', limitId: concurrency?.limit_id ?? 'concurrentJobs', source: concurrency?.source, retryAfter: failure.retryAfter ?? 15,
      title: `${retry}All your job slots are busy${at}`,
      text: `${slotsText(concurrency)} Wait for one to finish, then send again. ${nothing}`,
    };
  }

  if (failure.status === 403) {
    if (failure.code === 'feature_not_entitled') {
      return {
        ...base, kind: 'plan',
        title: `${retry}Not included in your plan${at}`,
        text: `${failure.message || 'The feature this run needs is not part of your plan right now.'} ${nothing}`,
      };
    }
    const permission = permissionOf(failure.message) ?? 'engines:execute';
    return {
      ...base, kind: 'key', permission,
      title: `This credential can’t ${action === 'cancel' ? 'cancel' : 'start'} runs${at}`,
      text: `${failure.message ? `${failure.message} ` : ''}Use a browser session, or a key that includes the permission below. ${nothing}`,
    };
  }

  if (failure.status === 404) {
    return action === 'launch'
      ? { ...base, kind: 'not-found', title: `Engine not available with this key${at}`, text: `The snapshot, the engine or its deployment isn’t visible to this account or key. ${nothing}` }
      : { ...base, kind: 'not-found', title: `Job not found${at}`, text: 'Jobs open only for whoever launched them. Nothing changed.' };
  }

  if (failure.status === 409) {
    if (action === 'cancel' || failure.code === 'terminal_job') {
      return { ...base, kind: 'terminal', title: `Already finished${at}`, text: 'This run had already finished, so it can’t be cancelled. Nothing changed.' };
    }
    if (action === 'retry' || failure.code === 'job_not_retryable') {
      return { ...base, kind: 'terminal', title: `This run can’t be retried${at}`, text: 'Only failed or cancelled runs can be retried. Nothing was started.' };
    }
    const reused = failure.code === 'idempotency_conflict';
    return {
      ...base, kind: 'conflict',
      title: reused ? `That one-time key was used for a different run${at}` : `The selection conflicts with a sealed one${at}`,
      text: `${reused ? 'Change nothing and send again; a fresh key is made for the new settings. ' : `${failure.message ? `${failure.message} ` : ''}`}${nothing}`,
    };
  }

  if (failure.status === 413) {
    return { ...base, kind: 'too-large', title: `Larger than your plan takes${at}`, text: `The request is bigger than your plan allows per request. ${nothing}` };
  }

  const diagnostics = caught instanceof HttpError ? caught.diagnostics ?? [] : [];
  if (failure.code === RANGE_CODE || diagnostics.some((row) => typeof row === 'object' && row !== null && (row as { code?: unknown }).code === RANGE_CODE)) {
    return rangeRefusal(diagnostics, at, failure.status);
  }

  if (failure.status === 422) {
    const incompatible = failure.code === 'engine_mode_incompatible';
    return {
      ...base, kind: incompatible ? 'incompatible' : 'other',
      title: incompatible ? `This engine can’t run this problem${at}` : `The gateway refused these settings${at}`,
      text: incompatible
        ? `The chosen mode doesn’t support part of this case (for example its placement kind). Pick another engine or mode. ${nothing}`
        : `${failure.message ? `${failure.message} ` : ''}Check the engine, mode and settings. ${nothing}`,
    };
  }

  if (failure.status === 503) {
    if (failure.code === USAGE_UNKNOWN_CODE) {
      return { ...base, kind: 'pricing', limitId: notice?.limit_id, title: `Your usage can’t be read right now${at}`, text: usageUnknownText(nothing) };
    }
    return failure.code === 'pricing_unavailable'
      ? { ...base, kind: 'pricing', title: `Limits can’t be checked right now${at}`, text: `Runs need a limit check before starting. Try again in a moment; ${nothing.toLowerCase()}` }
      : { ...base, kind: 'unavailable', title: `A service didn’t answer${at}`, text: `A service OpenBinding depends on isn’t answering. This says nothing about your account. ${nothing}` };
  }

  if (failure.kind === 'network') {
    return { ...base, kind: 'unavailable', title: 'OpenBinding couldn’t be reached', text: `Check your connection and try again. ${nothing}` };
  }
  return { ...base, kind: 'other', title: `That couldn’t be done${at}`, text: `${failure.message ? `${failure.message} ` : ''}${nothing}` };
}
