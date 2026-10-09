import { HttpError } from '../../api/client';
import { classifyAuthError, marker } from '../Account/accountErrors';

export type AnalysisProblemKind = 'stale' | 'busy' | 'missing' | 'key' | 'conflict' | 'session' | 'unavailable' | 'refused';

export interface AnalysisProblem {
  kind: AnalysisProblemKind;
  status?: number;
  title: string;
  text: string;
}

/**
 * What the gateway's refusals of the analysis calls mean to a person. A source that isn't theirs reads as missing (404), and a key
 * that can't reach it as 403: both are said together, because the gateway answers the same way for what doesn't exist.
 * A 422 arrives as a plain `Error` (the analysis client turns the body into one); its words are the gateway's own.
 */
export function analysisProblem(caught: unknown, doing = 'compare these sources'): AnalysisProblem {
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  if (caught instanceof HttpError) {
    switch (caught.status) {
      case 401:
        return { kind: 'session', status: 401, title: `Your session ended${at}`, text: 'Log in again to keep analysing.' };
      case 403:
        return { kind: 'key', status: 403, title: `This API key can’t read these results${at}`, text: 'It can’t read jobs, or doesn’t include the engines these results came from. Use a browser session or a key that does.' };
      case 404:
        return { kind: 'missing', status: 404, title: `These sources aren’t available${at}`, text: 'They aren’t yours, or they no longer exist. The answer is the same for both, so nothing is revealed about other accounts.' };
      case 409: {
        const said = failure.message ?? '';
        if (/changed|reload/i.test(said)) {
          return { kind: 'stale', status: 409, title: `The evidence changed${at}`, text: 'You are seeing the earlier snapshot. Refresh to recompute it from the stored results.' };
        }
        return { kind: 'conflict', status: 409, title: `These sources can’t be ranked together${at}`, text: `${said || 'They were checked against different models.'} Choose results of one model, or open them one at a time.` };
      }
      case 429:
        return { kind: 'busy', status: 429, title: `The evaluator is busy${at}`, text: 'The last ranking stays visible. Try again in a few seconds.' };
      default:
        if (caught.status >= 500) return { kind: 'unavailable', status: caught.status, title: `Analysis isn’t answering${at}`, text: 'A service OpenBinding depends on did not answer. This says nothing about your results. Try again in a moment.' };
    }
  }
  if (caught instanceof Error && !(caught instanceof HttpError) && !(caught instanceof TypeError)) {
    return { kind: 'refused', title: `The gateway refused to ${doing}`, text: caught.message };
  }
  return { kind: 'unavailable', title: 'OpenBinding couldn’t be reached', text: 'Check your connection and try again. Nothing was changed.' };
}
