import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { Diagnostic } from '../../api/problem';
import { inInterfaceWords } from '../../components/ui/interfaceWords';
import { limitProblemOf } from '../../utils/limitRefusals';
import { limitInfo } from '../../utils/limits';

/** What the gateway can refuse about a package (checking or saving it), sorted into the cases the screens have words for. */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export type RefusalKind =
  // `quota`: an allowance of the plan is used up (402), such as its repository storage.
  | 'invalid' | 'quota' | 'too-large' | 'session' | 'key' | 'unsupported' | 'busy' | 'unavailable' | 'other'
  // A size limit no plan sets: this deployment caps it, it couldn't be measured, or the plan can't be applied.
  | 'technical' | 'unmeasured' | 'misconfigured';

/** The refusals that are about a limit the package can't fix by being valid or by a credential: each has its own sentence in `message`. */
export const LIMIT_KINDS: readonly RefusalKind[] = ['technical', 'unmeasured', 'misconfigured'];

export interface Refusal {
  kind: RefusalKind;
  status?: number;
  /** The machine code the gateway sent, for people who need to quote it. */
  code?: string;
  /** The gateway's own sentence; for the limit kinds, the interface's (the gateway's is not repeated). */
  message: string;
  /** What the limit kinds are called, without the status and code. */
  title?: string;
  /** The problems a 422 lists, one per place in the package. */
  diagnostics: Diagnostic[];
  /** What a 402 or a size refusal names: the limit and its ceiling. */
  limitId?: string;
  limit?: number;
}

/** `(422)` or `(403 · api_key_boundary)`: the status and code of a refusal. */
export function refusalMarker(refusal: Pick<Refusal, 'status' | 'code'>): string {
  const parts = [refusal.status, refusal.code].filter((part) => part !== undefined && part !== '');
  return parts.length ? ` (${parts.join(' · ')})` : '';
}

/** Sort a failed call into the cases the editor has words for. */
export function refusalOf(caught: unknown): Refusal {
  if (caught instanceof QuotaError) {
    return {
      kind: 'quota', status: 402, code: caught.code, message: caught.message, diagnostics: [],
      limitId: caught.quota?.limit_id ?? caught.notice?.limit_id, limit: caught.quota?.limit ?? caught.notice?.limit,
    };
  }
  if (caught instanceof HttpError) {
    const base = {
      status: caught.status,
      code: caught.code,
      message: caught.message.replace(/^HTTP \d+: /, ''),
      diagnostics: (caught.diagnostics ?? []).filter((item): item is Diagnostic => isRecord(item)),
    };
    // A 422 over the deployment's size cap, or one whose size couldn't be measured, is not an invalid package, and a 503 for
    // a plan that can't be applied is not an outage: each is told in its own words.
    const limited = limitProblemOf(caught, '', '');
    if (limited) {
      return { ...base, kind: limited.kind, title: limited.title, message: limited.text.trim(), limitId: limited.limitId, limit: caught.notice?.limit };
    }
    switch (caught.status) {
      case 401: return { kind: 'session', ...base };
      case 403: return { kind: 'key', ...base };
      case 413: return { kind: 'too-large', ...base };
      case 415: return { kind: 'unsupported', ...base };
      case 422: return { kind: 'invalid', ...base };
      case 429: return { kind: 'busy', ...base };
      default: return { kind: caught.status >= 500 ? 'unavailable' : 'other', ...base };
    }
  }
  if (caught instanceof TypeError) return { kind: 'unavailable', message: 'OpenBinding could not be reached.', diagnostics: [] };
  return { kind: 'other', message: caught instanceof Error ? caught.message : String(caught), diagnostics: [] };
}

/** What a 402 is out of, in the words of the plan: `storage`, else `allowance`. */
function allowanceOf(refusal: Refusal): string {
  return refusal.limitId ? inInterfaceWords(limitInfo(refusal.limitId).short) : 'allowance';
}

/** The sentence for a refusal that isn't one of the screen's own states. */
export function refusalText(refusal: Refusal, doing: string): string {
  const marker = refusalMarker(refusal);
  switch (refusal.kind) {
    case 'technical':
    case 'unmeasured':
    case 'misconfigured': return `${refusal.message.replace(/\.$/, '')}${marker}, so ${doing}.`;
    case 'unsupported': return `The gateway doesn’t take this kind of file${marker}. Use a .bim.zip package.`;
    case 'busy': return `Too many requests${marker}. Wait a moment and try again.`;
    case 'unavailable': return `A service OpenBinding depends on isn’t answering${marker}, so ${doing}. This says nothing about your package; try again in a moment.`;
    case 'quota': return `Your plan’s ${allowanceOf(refusal)} is used up${marker}, so ${doing}. Free some, or see your plan.`;
    case 'too-large': return `This package is larger than this deployment allows per request${marker}, so ${doing}.`;
    case 'session': return `Your session has ended${marker}. Log in again; your package is kept in this browser.`;
    default: return refusal.status === undefined ? refusal.message : `${refusal.message || 'That couldn’t be done'}${marker}, so ${doing}.`;
  }
}

/** Saving: what each refusal of `POST …/problems` and `POST …/problems/{problem}/revisions` means. */
export function saveRefusalText(refusal: Refusal): string {
  const marker = refusalMarker(refusal);
  if (refusal.status === 409 && refusal.code === 'slug_conflict') return `That address is already used by another problem in this organization${marker}. Pick another one. Nothing was saved.`;
  switch (refusal.kind) {
    case 'key': return `You need MEMBER in the organization to save, and an API key needs problems:write${marker}. Nothing was saved.`;
    case 'session': return `Your session has ended${marker}. Log in again; the package is kept in this browser. Nothing was saved.`;
    case 'invalid': return `The gateway refused to seal this package${marker}. ${refusal.message ? `${refusal.message} ` : ''}Nothing was saved.`;
    case 'quota': return `Your plan has no room for this${marker}: it counts your problems and the ${allowanceOf(refusal)} your packages take. Nothing was saved.`;
    case 'too-large': return `This package is larger than this deployment allows per request${marker}. Nothing was saved.`;
    case 'other': return refusal.status === 404
      ? `That problem no longer exists, or you’re not in its organization${marker}. Nothing was saved.`
      : `${refusal.message || 'The version could not be saved'}${marker}. Nothing was saved.`;
    default: return refusalText(refusal, 'nothing was saved');
  }
}
