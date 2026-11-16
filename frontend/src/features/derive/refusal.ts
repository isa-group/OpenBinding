import { readApiError, type ApiError } from '../../shared/api/errors';

/** A refusal of the gateway, in words, with the findings a 422 carries. */
export interface Refusal {
  message: string;
  findings: ApiError['diagnostics'];
}

/** What a refusal of a derivation says, for the cases the dialog does not answer at a field. */
export function refusalOf(caught: unknown, what: 'create' | 'derive', from: 'run' | 'binding'): Refusal {
  const error = readApiError(caught);
  const code = error.status ? ` (${error.status}${error.code !== 'unknown' ? ` · ${error.code}` : ''})` : '';
  if (error.status === 403) {
    return { message: `Deriving a composition needs MEMBER in this organization${code}.`, findings: [] };
  }
  if (error.status === 404) {
    const source = from === 'run' ? 'The run' : 'The problem version';
    return { message: `${source} or the composition is not there any more, or you can’t read it${code}.`, findings: [] };
  }
  if (error.status === 422 && error.code === 'derivation_invalid') {
    const subject = from === 'run' ? 'This solution' : 'This binding';
    return { message: `${subject} can’t be written as a composition${code}. The gateway found:`, findings: error.diagnostics };
  }
  if (error.status === 429) {
    const wait = error.retryAfter ? ` Try again in ${error.retryAfter} s.` : ' Try again in a moment.';
    return { message: `The toolchain is busy${code}.${wait}`, findings: [] };
  }
  const subject = what === 'create' ? 'The composition couldn’t be created' : 'The composition couldn’t be derived';
  return { message: `${subject}${code}${error.message ? `: ${error.message}` : '.'}`, findings: error.diagnostics };
}
