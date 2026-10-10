import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { diagnosticLines } from '../../api/problem';
import { limitInfo } from '../../utils/limits';
import { classifyAuthError, marker } from '../Account/accountErrors';
import type { Refusal } from '../Jobs/jobErrors';

export type { Refusal };

export type ReportAction = 'create' | 'save' | 'freeze' | 'draft' | 'delete' | 'publish' | 'withdraw' | 'load';

const NOTHING: Record<ReportAction, string> = {
  create: 'Nothing was created.',
  save: 'Nothing was saved.',
  freeze: 'Nothing was frozen.',
  draft: 'Nothing changed.',
  delete: 'Nothing was deleted.',
  publish: 'Nothing was published.',
  withdraw: 'Nothing changed.',
  load: '',
};

const ADMIN_ACTIONS: ReportAction[] = ['delete', 'publish', 'withdraw'];

function detailsOf(caught: unknown): string[] {
  return caught instanceof HttpError ? diagnosticLines(caught) : [];
}

/** What a 422 of the report endpoints means: the evidence and provenance a sealed report must carry, and what a public one may cite. */
function unprocessable(code: string | undefined, said: string, nothing: string, base: Pick<Refusal, 'status' | 'code' | 'details'>, at: string): Refusal {
  const gateway = said ? `${said} ` : '';
  switch (code) {
    case 'incomplete_provenance':
    case 'invalid_provenance':
      return {
        ...base, kind: 'incompatible', title: `The provenance isn’t complete${at}`,
        text: `${gateway}A frozen report must name its study, datasets, software, BIM version, engine revisions and parameters, each with the digest that identifies it. Fill them in under “View source”. ${nothing}`,
      };
    case 'study_provenance_mismatch':
      return { ...base, kind: 'incompatible', title: `The provenance names another run${at}`, text: `study.runId and study.matrixDigest must match the run this report is pinned to. ${nothing}` };
    case 'incomplete_evidence':
    case 'invalid_evidence':
      return { ...base, kind: 'incompatible', title: `The evidence can’t be identified${at}`, text: `${gateway}Every job or run a report cites must be named exactly. ${nothing}` };
    case 'nonterminal_evidence':
      return { ...base, kind: 'terminal', title: `The evidence hasn’t finished${at}`, text: `A report is sealed only once every run and job it cites has ended. ${nothing}` };
    case 'evidence_digest_mismatch':
      return { ...base, kind: 'conflict', title: `The evidence changed since it was recorded${at}`, text: `A stored result differs from the one this report recorded. ${nothing}` };
    case 'foreign_evidence':
    case 'foreign_study_run':
      return { ...base, kind: 'incompatible', title: `That evidence belongs to another project${at}`, text: `A report may only cite study runs of its own project. ${nothing}` };
    case 'foreign_report_version':
      return { ...base, kind: 'incompatible', title: `That isn’t a sealed edition of this report${at}`, text: `Choose an edition of this report. ${nothing}` };
    case 'private_evidence':
      return { ...base, kind: 'incompatible', title: `Some of the evidence is private${at}`, text: `${gateway}Make the project or the study definition it comes from public first, or remove that evidence. ${nothing}` };
    case 'private_engine_dependency':
      return { ...base, kind: 'incompatible', title: `An engine the evidence used isn’t public${at}`, text: `Publish the exact engine contract before publishing this report. ${nothing}` };
    case 'private_dependency':
    case 'private_case_dependency':
      return { ...base, kind: 'incompatible', title: `A dependency of this report is private${at}`, text: `${gateway}Everything a public edition cites must be public. ${nothing}` };
    default:
      return { ...base, kind: 'other', title: `The gateway refused this${at}`, text: `${gateway}${nothing}`.trim() };
  }
}

/** The words for each way the gateway can refuse to create, change, seal, publish or withdraw a report. */
export function reportRefusal(caught: unknown, action: ReportAction): Refusal {
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  const nothing = NOTHING[action];
  const quota = caught instanceof QuotaError ? caught.quota : undefined;
  const base = { status: failure.status, code: failure.code, details: detailsOf(caught) };
  const said = failure.message ?? '';

  if (failure.status === 401) return { ...base, kind: 'session', title: `Your session ended${at}`, text: 'Log in again; what you wrote is kept on this page until you leave it.' };

  if (failure.status === 402) {
    const info = limitInfo(quota?.limit_id ?? 'storage');
    return {
      ...base, kind: 'quota', limitId: quota?.limit_id, title: `Out of ${info.short}${at}`,
      text: `${quota ? `You’ve used ${(quota.used ?? quota.limit).toLocaleString('en-US')} of ${quota.limit.toLocaleString('en-US')} ${info.short}.` : `You’ve used all your ${info.short}.`} ${nothing}`,
    };
  }

  if (failure.status === 403) {
    if (failure.code === 'api_key_boundary' || /api key/i.test(said)) {
      return { ...base, kind: 'key', permission: said.match(/\b([a-z]+:[a-z]+)\b/)?.[1] ?? 'reports:write', title: `This API key can’t do that${at}`, text: `${said ? `${said} ` : ''}Use a browser session, or a key that includes the permission below. ${nothing}` };
    }
    const need = ADMIN_ACTIONS.includes(action) ? 'ADMIN' : 'MEMBER';
    return { ...base, kind: 'key', title: `Your role doesn’t reach this${at}`, text: `${action === 'load' ? 'Reading reports' : 'This'} needs ${action === 'load' ? 'VIEWER' : need} in the organization. ${nothing}`.trim() };
  }

  if (failure.status === 404) return { ...base, kind: 'not-found', title: `Not found${at}`, text: `It no longer exists, or you’re not in the organization it belongs to. ${nothing}`.trim() };

  if (failure.status === 409) {
    switch (failure.code) {
      case 'draft_conflict':
        return { ...base, kind: 'conflict', title: `Someone saved a newer draft revision${at}`, text: `Reload it before saving. What you typed is still in the editor; copy it first if you want to keep it. ${nothing}` };
      case 'report_frozen':
        return { ...base, kind: 'terminal', title: `This edition is frozen${at}`, text: `A frozen edition never changes. Start a new draft from it to edit. ${nothing}` };
      case 'report_not_frozen':
        return { ...base, kind: 'terminal', title: `Only frozen editions can be published${at}`, text: `Freeze this report first. ${nothing}` };
      case 'publication_conflict':
        return { ...base, kind: 'conflict', title: `That address is used, or this edition is already published${at}`, text: `Change the public address, or open the existing publication. ${nothing}` };
      case 'publication_withdrawn':
        return { ...base, kind: 'conflict', title: `This edition was published and withdrawn${at}`, text: `A withdrawn edition keeps its link; it can’t be published again. Freeze a new edition. ${nothing}` };
      case 'report_history_retained':
        return { ...base, kind: 'terminal', title: `This report has frozen editions${at}`, text: `Editions stay citable, so the report can’t be deleted. ${nothing}` };
      case 'slug_conflict':
        return { ...base, kind: 'conflict', title: `That address is already used${at}`, text: `Another report of this project has it. Change the address. ${nothing}` };
      case 'sealed_evidence':
        return { ...base, kind: 'terminal', title: `This evidence is cited by a sealed edition${at}`, text: `It can’t be removed or changed. ${nothing}` };
      default:
        return { ...base, kind: 'conflict', title: `That conflicts with something sealed${at}`, text: `${said ? `${said} ` : ''}${nothing}`.trim() };
    }
  }

  if (failure.status === 422) return unprocessable(failure.code, said, nothing, base, at);

  if (failure.status === 503 || failure.kind === 'unavailable') return { ...base, kind: 'unavailable', title: `A service didn’t answer${at}`, text: `A service OpenBinding depends on isn’t answering. This says nothing about your account. ${nothing}`.trim() };
  if (failure.kind === 'network') return { ...base, kind: 'unavailable', title: 'OpenBinding couldn’t be reached', text: `Check your connection and try again. ${nothing}`.trim() };
  return { ...base, kind: 'other', title: `That couldn’t be done${at}`, text: `${said ? `${said} ` : ''}${nothing}`.trim() };
}
