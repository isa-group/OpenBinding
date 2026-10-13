import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { diagnosticLines, problemField } from '../../api/problem';
import { limitInfo } from '../../utils/limits';
import { classifyAuthError, marker } from '../Account/accountErrors';
import type { Refusal } from '../Jobs/jobErrors';

export type { Refusal };

export type StudyAction = 'create' | 'run' | 'cancel' | 'retry' | 'attach' | 'archive' | 'delete' | 'update' | 'report';

const NOTHING: Record<StudyAction, string> = {
  create: 'Nothing was created.',
  run: 'Nothing was started.',
  cancel: 'Nothing changed.',
  retry: 'Nothing was started.',
  attach: 'Nothing changed.',
  archive: 'Nothing changed.',
  delete: 'Nothing was deleted.',
  update: 'Nothing changed.',
  report: 'Nothing was created.',
};

function detailsOf(caught: unknown): string[] {
  return caught instanceof HttpError ? diagnosticLines(caught) : [];
}

/** What a mismatch between a cell and a job can differ in (`cell_job_mismatch.fields`), in the words of the cell. */
const MISMATCH_FIELDS: Record<string, string> = { case_revision: 'case', engine: 'engine', mode: 'mode', seed: 'seed' };

function shown(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which of case, engine, mode and seed a job does not share with the cell it was meant for (`409 cell_job_mismatch`), with what each
 * side has when the gateway says. `details` is read either per field (`{ seed: { cell, job } }`) or per side (`{ cell: { seed }, job: { seed } }`).
 */
export function mismatchedFields(caught: unknown): Array<{ field: string; label: string; cell?: string; job?: string }> {
  const raw = problemField(caught, 'fields');
  const names = Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : [];
  const details = problemField(caught, 'details');
  const sides = isRecord(details) ? details : {};
  return names.map((field) => {
    const own = sides[field];
    const cell = isRecord(own) && 'cell' in own ? shown(own.cell) : isRecord(sides.cell) && field in sides.cell ? shown(sides.cell[field]) : undefined;
    const job = isRecord(own) && 'job' in own ? shown(own.job) : isRecord(sides.job) && field in sides.job ? shown(sides.job[field]) : undefined;
    return { field, label: MISMATCH_FIELDS[field] ?? field.replace(/_/g, ' '), ...(cell !== undefined ? { cell } : {}), ...(job !== undefined ? { job } : {}) };
  });
}

/**
 * The words for each way the gateway can refuse to create, run, cancel, retry or change a study. The same `Refusal` the job screens use,
 * so one notice component draws both; what changes is what each status means for a study.
 */
export function studyRefusal(caught: unknown, action: StudyAction): Refusal {
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  const nothing = NOTHING[action];
  const quota = caught instanceof QuotaError ? caught.quota : undefined;
  const base = { status: failure.status, code: failure.code, details: detailsOf(caught) };
  const gateway = failure.message ? `${failure.message} ` : '';

  if (failure.status === 401) {
    return { ...base, kind: 'session', title: `Your session ended${at}`, text: 'Log in again; what you chose is kept.' };
  }

  if (failure.status === 402) {
    const limitId = quota?.limit_id ?? 'studies';
    const info = limitInfo(limitId);
    const used = quota ? ` ${(quota.used ?? quota.limit).toLocaleString('en-US')} of ${quota.limit.toLocaleString('en-US')} used.` : '';
    if (limitId === 'studies') {
      return {
        ...base, kind: 'quota', limitId,
        title: `The sponsor has no study definitions left${at}`,
        text: `Studies are counted across the sponsor’s organizations and don’t renew.${used} Archive or delete one you no longer need, or ask about a larger plan. ${nothing}`,
      };
    }
    return {
      ...base, kind: 'quota', limitId,
      title: `Out of ${info.short}${at}`,
      text: `${quota ? `You’ve used ${(quota.used ?? quota.limit).toLocaleString('en-US')} of ${quota.limit.toLocaleString('en-US')} ${info.short}.` : `You’ve used all your ${info.short}.`} ${nothing}`,
    };
  }

  if (failure.status === 429) {
    const concurrency = caught instanceof HttpError ? caught.concurrency : undefined;
    const slots = concurrency ? `You can run ${concurrency.limit} job${concurrency.limit === 1 ? '' : 's'} at once.` : 'You have no free job slot.';
    return {
      ...base, kind: 'busy', limitId: concurrency?.limit_id ?? 'concurrentJobs', retryAfter: failure.retryAfter ?? 15,
      title: `All your job slots are busy${at}`,
      text: `${slots} Try again in about ${failure.retryAfter ?? 15} s. ${nothing}`,
    };
  }

  if (failure.status === 403) {
    if (failure.code === 'feature_not_entitled') {
      return { ...base, kind: 'plan', title: `Your plan doesn’t include studies right now${at}`, text: `${gateway}${nothing}` };
    }
    if (failure.code === 'api_key_engine_forbidden') {
      return {
        ...base, kind: 'key', title: `This API key isn’t allowed to use one of the study’s engines${at}`,
        text: `${gateway}Use a browser session, or a key whose engine access includes every engine the study pins. ${nothing}`,
      };
    }
    const permission = failure.message?.match(/\b([a-z]+:[a-z]+)\b/)?.[1] ?? 'studies:write';
    return {
      ...base, kind: 'key', permission, title: `This account or key can’t do that${at}`,
      text: `${action === 'delete' ? 'Deleting needs ADMIN in the organization. ' : 'It needs MEMBER in the organization and, for a key, the permission below. '}${nothing}`,
    };
  }

  if (failure.status === 404) {
    return {
      ...base, kind: 'not-found', title: `Not found${at}`,
      text: action === 'attach'
        ? `The cell, or the job, doesn’t exist or isn’t yours: only a finished job you launched can be attached. ${nothing}`
        : `It no longer exists, or you’re not in the organization it belongs to. ${nothing}`,
    };
  }

  if (failure.status === 409) {
    switch (failure.code) {
      case 'slug_conflict':
        return { ...base, kind: 'conflict', title: `That address is already used${at}`, text: `Another study of this project has it. Change the address. ${nothing}` };
      case 'study_archived':
        return { ...base, kind: 'conflict', title: `This study is archived${at}`, text: `Restore it to run again. ${nothing}` };
      case 'evidence_only_study':
        return { ...base, kind: 'conflict', title: `This study only holds stored evidence${at}`, text: `It isn’t an executable definition, so it can’t run engines. ${nothing}` };
      case 'sealed_evidence':
        return { ...base, kind: 'terminal', title: `A sealed report cites this run${at}`, text: `Its results can’t change now. Start a new run instead. ${nothing}` };
      case 'terminal_run':
        return { ...base, kind: 'terminal', title: `This run already finished${at}`, text: `There’s nothing left to cancel. ${nothing}` };
      case 'cell_not_retryable':
        return { ...base, kind: 'terminal', title: `This cell can’t be retried${at}`, text: `Only failed or cancelled cells can. ${nothing}` };
      case 'job_not_finished':
        return { ...base, kind: 'terminal', title: `That job hasn’t finished${at}`, text: `Attach a job that completed, failed or was cancelled. ${nothing}` };
      case 'job_result_missing':
        return { ...base, kind: 'terminal', title: `That job finished without a result${at}`, text: `There is nothing to attach. Pick a job that produced a result. ${nothing}` };
      case 'job_already_attached':
        return { ...base, kind: 'conflict', title: `That job is already the result of another cell${at}`, text: `A job stands for one cell only. Pick another job. ${nothing}` };
      case 'cell_job_mismatch': {
        const differing = mismatchedFields(caught);
        const names = differing.map((item) => item.label);
        const list = names.length ? ` It differs in the ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}.` : '';
        return {
          ...base,
          kind: 'conflict',
          title: `That job isn’t a run of this cell${at}`,
          text: `A cell takes the result of a job that ran its case revision with its engine, mode and seed.${list} Pick a job that matches. ${nothing}`,
          details: differing.length
            ? differing.map((item) => `${item.label[0].toUpperCase()}${item.label.slice(1)}: ${item.cell !== undefined || item.job !== undefined ? `the cell has ${item.cell ?? 'unknown'}, the job ran ${item.job ?? 'unknown'}` : 'does not match'}`)
            : base.details,
        };
      }
      case 'study_history_retained':
        return { ...base, kind: 'conflict', title: `This study has runs${at}`, text: `Runs are history, so it can’t be deleted; it can be archived. ${nothing}` };
      default:
        return { ...base, kind: 'conflict', title: `That conflicts with something sealed${at}`, text: `${gateway}${nothing}` };
    }
  }

  if (failure.status === 422) {
    switch (failure.code) {
      case 'study_matrix_too_large':
        return { ...base, kind: 'too-big', title: `The matrix is too large${at}`, text: `A study may pin at most 250 cases and expand to at most 10,000 cells. Remove an engine, a setting or some seeds. ${nothing}` };
      case 'empty_study_cases':
        return { ...base, kind: 'other', title: `The study needs a case${at}`, text: `Choose at least one case revision, or a sealed collection with cases in it. ${nothing}` };
      case 'foreign_case_revision':
        return { ...base, kind: 'other', title: `A case revision isn’t in this organization${at}`, text: `Every case revision of a study must belong to this organization. ${nothing}` };
      case 'unavailable_collection':
        return { ...base, kind: 'other', title: `That collection isn’t available${at}`, text: `Choose a sealed collection version you can read. ${nothing}` };
      case 'engine_mode_incompatible':
      case 'invalid_engine':
        return { ...base, kind: 'incompatible', title: `An engine can’t run this${at}`, text: `${gateway}Pick another engine or mode. ${nothing}` };
      default:
        return { ...base, kind: 'other', title: `The gateway refused these choices${at}`, text: `${gateway}Check the cases, engines, settings and seeds. ${nothing}` };
    }
  }

  if (failure.status === 503) {
    return failure.code === 'pricing_unavailable'
      ? { ...base, kind: 'pricing', title: `Limits can’t be checked right now${at}`, text: `A study needs a limit check first. Try again in a moment. ${nothing}` }
      : { ...base, kind: 'unavailable', title: `A service didn’t answer${at}`, text: `A service OpenBinding depends on isn’t answering. This says nothing about your account. ${nothing}` };
  }

  if (failure.kind === 'network') {
    return { ...base, kind: 'unavailable', title: 'OpenBinding couldn’t be reached', text: `Check your connection and try again. ${nothing}` };
  }
  return { ...base, kind: 'other', title: `That couldn’t be done${at}`, text: `${gateway}${nothing}` };
}
