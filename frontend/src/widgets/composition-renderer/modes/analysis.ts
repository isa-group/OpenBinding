import { readApiError, type ApiError } from '../../../shared/api/errors';

// What the two analysis modes (`calculator`, `configurator`) share: the binding they hand the page, the callbacks the page answers
// (a widget never opens a feature's dialog itself), and how they word a refusal of the gateway.

/** Each task's candidate as a document writes it (its id, or `<resource>/<id>`). */
export type WrittenBinding = Record<string, string>;

/** A binding of the linked problem version to derive as a version: what `derive` takes besides the label. */
export interface BindingDerivation {
  /** `<problem>@<revision>`, as the version links it. */
  revision: string;
  binding: WrittenBinding;
}

/** The page's answers to the analysis modes; an action without its callback is not offered. */
export interface AnalysisActions {
  /** Open this binding in the configurator. */
  onTry?: (binding: WrittenBinding) => void;
  /** Derive this binding as a version (MEMBER): the page opens the derive dialog. */
  onDerive?: (source: BindingDerivation) => void;
  /** Open this binding in the Editor as a draft (MEMBER): the page asks for the derived document and opens it. */
  onOpenDraft?: (source: BindingDerivation) => void;
  /** The gateway says the version links no problem after all (422 `composition_not_linked`). */
  onNotLinked?: () => void;
  /** The binding the configurator starts from; the version's when none is given. */
  start?: WrittenBinding;
}

/** Why the analysis modes are not shown, on a version they cannot work on. */
export const NOT_LINKED = 'Values are declared: the calculator and configurator need a linked problem you can read.';

export interface AnalysisRefusal {
  message: string;
  /** The findings a 422 carries (`/binding/<task>` pointers for the tasks the request rebound). */
  findings: ApiError['diagnostics'];
  /** The version links no problem (422 `composition_not_linked`). */
  notLinked: boolean;
}

/** A refusal of `evaluate` or `neighborhood`, in words. */
export function analysisRefusal(caught: unknown, subject: string): AnalysisRefusal {
  const error = readApiError(caught);
  const code = error.status ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})` : '';
  if (error.status === 422 && error.code === 'composition_not_linked') return { message: NOT_LINKED, findings: [], notLinked: true };
  if (error.status === 409 && error.code === 'composition_empty') {
    return { message: `This composition has no version to evaluate yet${code}.`, findings: [], notLinked: false };
  }
  if (error.status === 429) {
    const wait = error.retryAfter ? ` Try again in ${error.retryAfter} s.` : ' Try again in a moment.';
    return { message: `The toolchain is busy${code}.${wait}`, findings: [], notLinked: false };
  }
  return { message: `${subject}${code}${error.message ? `: ${error.message}` : '.'}`, findings: error.diagnostics, notLinked: false };
}

/** The task a finding points at, when it points into the request's binding (`/binding/<task>`, RFC 6901). */
export function findingTask(pointer: string | undefined | null): string | null {
  const segments = (pointer ?? '').split('/');
  if (segments.length < 3 || segments[0] !== '' || segments[1] !== 'binding') return null;
  return segments[2].replace(/~1/g, '/').replace(/~0/g, '~');
}
