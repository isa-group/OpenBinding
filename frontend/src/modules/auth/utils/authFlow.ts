/**
 * Small pieces of browser state that the sign-in screens hand to one another.
 *
 * Everything here lives in sessionStorage (one tab, gone when it closes) and holds no credential: an
 * internal path or a flag. Tokens never pass through this module.
 */

const SESSION_ENDED_KEY = 'openbinding-session-ended';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * An internal address that a sign-in may send the person back to, or `null`.
 *
 * Only the workspace, the account's own pages (`/me/…`), the organization pages (`/orgs/…`, the invitation link included), the
 * composition pages (`/compositions/…`, where Fork asks for a session), the permanent links (`/p/…`) and the composition
 * editor (`/editor`, whose Sign in carries the text in the fragment) and the problem editor (`/problem-editor`, whose Sign in
 * keeps the package in this browser) qualify: the value travels through router state and sessionStorage, so it is never used as an arbitrary redirect target.
 */
export function safeReturnPath(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return null;
  const path = value.split(/[?#]/)[0];
  if (/^\/(me|orgs|problems|runs|studies|admin|engines)\//.test(path)) return value;
  if (path === '/admin' || path === '/notifications') return value;
  if (path === '/compositions' || path.startsWith('/compositions/') || path.startsWith('/p/'))
    return value;
  if (path === '/editor' || path === '/problem-editor') return value;
  return null;
}

/** Where to go once signed in: the page that asked for the session, else the workspace. */
export function afterSignInTarget(from: unknown): string {
  return safeReturnPath(from) ?? '/';
}

const SIGN_IN_KEY = 'openbinding-sign-in-started';
/** A sign-in that finished more than this long ago is not "just now". */
const SIGN_IN_MAX_AGE_MS = 30_000;

/**
 * The whole interface below the account provider is mounted again when the account changes (the SPACE client is
 * keyed on the user id), so the screen that signed somebody in is not the one that sees them signed in. This note
 * is how the new instance knows that the person did not arrive already signed in, and where to send them.
 */
export function noteSignInStarted(): void {
  storage()?.setItem(SIGN_IN_KEY, String(Date.now()));
}

export function clearSignInNote(): void {
  storage()?.removeItem(SIGN_IN_KEY);
}

/** True when a sign-in or registration from this tab finished a moment ago. */
export function hasRecentSignIn(): boolean {
  const at = Number(storage()?.getItem(SIGN_IN_KEY));
  return Number.isFinite(at) && at > 0 && Date.now() - at < SIGN_IN_MAX_AGE_MS;
}

export function markSessionEnded(): void {
  storage()?.setItem(SESSION_ENDED_KEY, '1');
}

export function clearSessionEnded(): void {
  storage()?.removeItem(SESSION_ENDED_KEY);
}

/** True when the last session ended without the person asking (a renewal that was refused). */
export function hasSessionEnded(): boolean {
  return storage()?.getItem(SESSION_ENDED_KEY) === '1';
}
