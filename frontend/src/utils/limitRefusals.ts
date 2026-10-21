/**
 * The words for a request refused over a limit that isn't a plain "you used it all".
 *
 * The gateway tells apart four things the interface used to run together, and each calls for a different
 * sentence and a different way forward:
 *
 * - `403 binding_space_limit_unknown`: the plan doesn't say how large a problem may be. It is not a
 *   permission and not a key, and a larger plan doesn't help: the information is missing.
 * - `422 binding_space_over_technical_limit`: this deployment caps the problem size whatever the plan, so
 *   a larger plan changes nothing; reducing the candidates does.
 * - `422 binding_space_unmeasured`: the gateway couldn't work out the size. A fault on its side.
 * - `503 pricing_misconfigured`: a limit of the plan can't be applied. Also not the person's doing.
 *
 * The sentences are fixed and built from numbers only. The gateway's own `detail` text is never repeated
 * for these, and nothing of the answer beyond the measure (see `api/limitNotice.ts`) reaches the page.
 * No sentence says "credits", "balance" or "capacity units": a limit is a ceiling on something measurable.
 */

import { QuotaError } from '../api/auth';
import { HttpError } from '../api/client';
import type { BindingSpaceReport, LimitNotice } from '../api/limitNotice';
import { formatPowerOfTen } from './limits';

export const LIMIT_UNKNOWN_CODE = 'binding_space_limit_unknown';
export const OVER_TECHNICAL_CODE = 'binding_space_over_technical_limit';
export const UNMEASURED_CODE = 'binding_space_unmeasured';
export const COMPLEXITY_CODE = 'instance_complexity_too_large';
export const MISCONFIGURED_CODE = 'pricing_misconfigured';
/** A period counter of the pricing service is spent (402) or couldn't be read (503). */
export const USAGE_EXHAUSTED_CODE = 'usage_limit_exceeded';
export const USAGE_UNKNOWN_CODE = 'usage_limit_unknown';
export const CELLS_CODE = 'study_run_too_large';

export type LimitProblemKind = 'limit-unknown' | 'technical' | 'unmeasured' | 'misconfigured';

export interface LimitProblem {
  kind: LimitProblemKind;
  title: string;
  text: string;
  limitId?: string;
  source?: string;
}

/** The limit a refusal names, if the client kept one. */
export function noticeOf(caught: unknown): LimitNotice | undefined {
  return caught instanceof QuotaError || caught instanceof HttpError ? caught.notice : undefined;
}

/** The measured size a refusal carries, if any. */
export function bindingSpaceOf(caught: unknown): BindingSpaceReport | undefined {
  return caught instanceof QuotaError || caught instanceof HttpError ? caught.bindingSpace : undefined;
}

/** `10⁹` for a whole exponent, `10^4.3` otherwise: the size of a binding space as a power of ten. */
export function combinations(log10: number): string {
  const rounded = Math.round(log10 * 10) / 10;
  return Number.isInteger(rounded) ? formatPowerOfTen(rounded) : `10^${rounded}`;
}

const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** How big the problem is, in words: the exact count when the gateway sent one, else its size as a power of ten; `null` when it didn't say. */
export function sizeOf(space?: BindingSpaceReport, notice?: LimitNotice): string | null {
  if (space?.cardinality) return `${grouped(space.cardinality)} combinations`;
  const log10 = space?.log10 ?? (notice?.state === 'exhausted' ? notice.used : undefined);
  if (log10 !== undefined) return `about ${combinations(log10)} combinations`;
  if (space?.digits !== undefined) return `a number of combinations with ${space.digits.toLocaleString('en-US')} digits`;
  return null;
}

/** The sentence for a 402 over the plan's size limit: how big the problem is and what the plan allows. */
export function complexityText(caught: unknown, nothing: string): string {
  const notice = noticeOf(caught);
  const quota = caught instanceof QuotaError ? caught.quota : undefined;
  const size = sizeOf(bindingSpaceOf(caught), notice);
  const ceiling = notice?.limit ?? quota?.limit;
  let said: string;
  if (size && ceiling !== undefined) said = `This problem has ${size}; your plan allows up to ${combinations(ceiling)} combinations.`;
  else if (size) said = `This problem has ${size}, more than your plan allows.`;
  else if (ceiling !== undefined) said = `This problem has more combinations than your plan allows (up to ${combinations(ceiling)}).`;
  else said = 'This problem has more combinations than your plan allows.';
  return `${said} Reduce the candidates or ask about a larger plan. ${nothing}`;
}

/** The refusals about a limit that is unknown, unmeasurable, technical or unappliable; `null` for any other answer. */
export function limitProblemOf(caught: unknown, nothing: string, at: string): LimitProblem | null {
  const code = caught instanceof QuotaError || caught instanceof HttpError ? caught.code : undefined;
  const notice = noticeOf(caught);
  switch (code) {
    case LIMIT_UNKNOWN_CODE:
      return {
        kind: 'limit-unknown', limitId: notice?.limit_id ?? 'maxInstanceComplexityLog10', source: 'none',
        title: `Your plan doesn’t set a problem-size limit${at}`,
        text: `Your plan doesn’t say how large a problem may be, so this one can’t be accepted. A larger plan won’t fix it: the plan is missing that information. Contact the administrator. ${nothing}`,
      };
    case OVER_TECHNICAL_CODE: {
      const size = sizeOf(bindingSpaceOf(caught), notice);
      const ceiling = notice?.limit;
      return {
        kind: 'technical', limitId: notice?.limit_id ?? 'maxInstanceComplexityLog10', source: 'technical',
        title: `Over this deployment’s size limit${at}`,
        text: `This deployment limits how large a problem can be${ceiling !== undefined ? ` (up to ${combinations(ceiling)} combinations)` : ''}, whatever the plan, so a larger plan won’t change it.${size ? ` This problem has ${size}.` : ''} Reduce the candidates. ${nothing}`,
      };
    }
    case UNMEASURED_CODE:
      return {
        kind: 'unmeasured', limitId: notice?.limit_id ?? 'maxInstanceComplexityLog10',
        title: `The problem’s size couldn’t be measured${at}`,
        text: `OpenBinding couldn’t work out how large this problem is, so it can’t check it against the limit. This is a fault on the service’s side, not a mistake in your package. Try again; if it keeps happening, report it with the code shown. ${nothing}`,
      };
    case MISCONFIGURED_CODE:
      return {
        kind: 'misconfigured',
        title: `Your plan can’t be applied${at}`,
        text: `A limit in your account’s plan is missing or can’t be applied, so runs can’t start. This isn’t something you did. Contact the administrator. ${nothing}`,
      };
    default:
      return null;
  }
}

/** Who sets a concurrency limit, as the sentence about how many jobs may run at once. */
export function slotsText(concurrency?: { limit: number; source?: string }): string {
  if (!concurrency) return 'You have no free job slot.';
  const jobs = `${concurrency.limit} job${concurrency.limit === 1 ? '' : 's'}`;
  if (concurrency.source === 'technical') return `This deployment lets one account run ${jobs} at once, whatever its plan.`;
  if (concurrency.source === 'plan') return `Your plan lets you run ${jobs} at once.`;
  return `You can run ${jobs} at once.`;
}

/** The sentence for an unreadable period counter (503): a moment's wait, not an account problem. */
export function usageUnknownText(nothing: string): string {
  return `Starting needs a check of how much of your plan’s usage is left, and that couldn’t be read right now. Try again in a moment. ${nothing}`;
}
