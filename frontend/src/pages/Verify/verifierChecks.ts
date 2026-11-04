import { HttpError } from '../../api/client';
import { platformApi, type VerifierVerdict } from '../../api/platform';
import { computeCanonicalDigest, computeFileSha256 } from '../../utils/canonicalDigest';
import { isDigest, normalizeDigest } from '../../utils/digest';
import { classifyAuthError, marker } from '../Account/accountErrors';

export type Mode = 'digest' | 'text' | 'file';

const BAD_FINGERPRINT = 'That isn’t a valid fingerprint. A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.';

/** Input the page itself refuses before asking the server. */
export class InputError extends Error {}

export interface Result {
  mode: Mode;
  verdict: VerifierVerdict;
  /** The fingerprint the browser computed (document or file), when there was something to compute. */
  client: string | null;
  /** The fingerprint the person typed. */
  given: string | null;
}

export async function verifyDigest(raw: string): Promise<Result> {
  const given = normalizeDigest(raw);
  if (!isDigest(given)) throw new InputError(BAD_FINGERPRINT);
  return { mode: 'digest', verdict: await platformApi.verifierCheck({ digest: given }), client: null, given };
}

export async function verifyText(text: string, expected: string): Promise<Result> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError('That text isn’t a JSON document. The verifier fingerprints documents after normalising them, so spacing and key order don’t matter, but the content must be JSON.');
  }
  const given = expected.trim() ? normalizeDigest(expected) : null;
  if (given && !isDigest(given)) throw new InputError(BAD_FINGERPRINT);
  const client = await computeCanonicalDigest(parsed);
  return { mode: 'text', verdict: await platformApi.verifierCheck({ document: parsed, digest: given }), client, given };
}

export async function verifyFile(file: File): Promise<Result> {
  const client = await computeFileSha256(file);
  return { mode: 'file', verdict: await platformApi.verifierCheckFile(file, file.name), client, given: null };
}

export interface Problem {
  title: string;
  text: string;
  /** The session ended: the notice offers to log in again. */
  session: boolean;
}

export function problemOf(caught: unknown): Problem {
  if (caught instanceof InputError) return { title: 'That can’t be checked', text: caught.message, session: false };
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  if (failure.status === 401) return { title: `Your session ended${at}`, text: 'Log in again to keep checking.', session: true };
  if (failure.status === 413) return { title: `That file is too large to check here${at}`, text: 'Compute its SHA-256 yourself and paste the fingerprint instead.', session: false };
  if (failure.status === 422) return { title: `That isn’t a valid fingerprint or document${at}`, text: `${failure.message ? `${failure.message}. ` : ''}A fingerprint is sha256- followed by 64 lowercase hexadecimal characters.`, session: false };
  if (failure.status === 403) return { title: `This API key can’t use the verifier${at}`, text: 'Use a browser session, or a key with instances:read.', session: false };
  if (failure.kind === 'unavailable' || failure.kind === 'network') return { title: 'The verifier didn’t answer', text: `A service OpenBinding depends on isn’t answering${at}. This says nothing about the content. Try again in a moment.`, session: false };
  return { title: `The check failed${at}`, text: caught instanceof HttpError ? caught.message : 'Try again.', session: false };
}
