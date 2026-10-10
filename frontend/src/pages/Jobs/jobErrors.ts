import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { diagnosticLines } from '../../api/problem';
import { formatDate } from '../../utils/format';
import { limitInfo } from '../../utils/limits';
import { classifyAuthError, marker } from '../Account/accountErrors';

export type JobAction = 'launch' | 'retry' | 'cancel';

export type RefusalKind =
  | 'quota' | 'too-big' | 'busy' | 'plan' | 'key' | 'incompatible' | 'not-found' | 'conflict' | 'terminal'
  | 'pricing' | 'session' | 'too-large' | 'unavailable' | 'other';

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
  /** The permission an API key is missing (403). */
  permission?: string;
}

function detailsOf(caught: unknown): string[] {
  return caught instanceof HttpError ? diagnosticLines(caught, 8) : [];
}

function renewal(renewsAt: string | null | undefined): string {
  const date = formatDate(renewsAt);
  return date ? ` They renew on ${date}.` : '';
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

  if (failure.status === 402) {
    const complexity = failure.code === 'instance_complexity_too_large' || quota?.limit_id === 'maxInstanceComplexityLog10';
    if (complexity) {
      return {
        ...base, kind: 'too-big', limitId: quota?.limit_id,
        title: `Too big for your plan${at}`,
        text: `This problem has more combinations than your plan allows. Reduce candidates or ask about a larger plan. ${nothing}`,
      };
    }
    const info = limitInfo(quota?.limit_id ?? 'taskStarts');
    const noun = quota?.limit_id === 'taskStarts' || !quota ? 'solves' : info.short;
    const spent = quota ? `You’ve used ${(quota.used ?? quota.limit).toLocaleString('en-US')} of ${quota.limit.toLocaleString('en-US')} ${noun}.` : `You’ve used all your ${noun}.`;
    return {
      ...base, kind: 'quota', limitId: quota?.limit_id ?? 'taskStarts',
      title: `${retry}${noun === 'solves' ? 'Out of solves this month' : `Out of ${noun}`}${at}`,
      text: `${spent}${renewal(quota?.renews_at)} ${nothing}`,
    };
  }

  if (failure.status === 429) {
    const concurrency = caught instanceof HttpError ? caught.concurrency : undefined;
    const slots = concurrency ? `You can run ${concurrency.limit} job${concurrency.limit === 1 ? '' : 's'} at once.` : 'You have no free job slot.';
    return {
      ...base, kind: 'busy', limitId: concurrency?.limit_id ?? 'concurrentJobs', retryAfter: failure.retryAfter ?? 15,
      title: `${retry}All your job slots are busy${at}`,
      text: `${slots} Wait for one to finish, then send again. ${nothing}`,
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
    return failure.code === 'pricing_unavailable'
      ? { ...base, kind: 'pricing', title: `Limits can’t be checked right now${at}`, text: `Runs need a limit check before starting. Try again in a moment; ${nothing.toLowerCase()}` }
      : { ...base, kind: 'unavailable', title: `A service didn’t answer${at}`, text: `A service OpenBinding depends on isn’t answering. This says nothing about your account. ${nothing}` };
  }

  if (failure.kind === 'network') {
    return { ...base, kind: 'unavailable', title: 'OpenBinding couldn’t be reached', text: `Check your connection and try again. ${nothing}` };
  }
  return { ...base, kind: 'other', title: `That couldn’t be done${at}`, text: `${failure.message ? `${failure.message} ` : ''}${nothing}` };
}
