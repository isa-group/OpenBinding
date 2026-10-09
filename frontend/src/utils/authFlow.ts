/**
 * Small pieces of browser state that the sign-in screens hand to one another.
 *
 * Everything here lives in sessionStorage (one tab, gone when it closes) and holds no credential: a
 * mode, an internal path or a flag. Tokens never pass through this module.
 */

const SESSION_ENDED_KEY = 'openbinding-session-ended';
const CAS_FLOW_KEY = 'openbinding-cas-flow';
/** A CAS round trip that takes longer than this was abandoned, so its memory is not trusted. */
const CAS_FLOW_MAX_AGE_MS = 30 * 60 * 1000;

export type CasMode = 'login' | 'link';

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
 * Only the workspace and the invitation page qualify: the value travels through router state and
 * sessionStorage, so it is never used as an arbitrary redirect target.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  const path = value.split(/[?#]/)[0];
  if (path === '/app' || path.startsWith('/app/') || path === '/invitations/accept') return value;
  return null;
}

/** Where to go once signed in: the page that asked for the session, else the workspace. */
export function afterSignInTarget(from: unknown): string {
  return safeReturnPath(from) ?? '/app';
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

const casExchanges = new Map<string, Promise<void>>();
const casFlows = new Map<string, CasFlow | null>();

/**
 * The CAS flow that belongs to a callback with this code. The first read is cached against the code, so the screen
 * that is mounted again once the exchange signs the person in finds the same answer after the memory is forgotten.
 */
export function casFlowFor(code: string | null): CasFlow | null {
  if (!code) return readCasFlow();
  if (!casFlows.has(code)) casFlows.set(code, readCasFlow());
  return casFlows.get(code) ?? null;
}

/**
 * Run the exchange of a CAS code once, however many times the callback screen is mounted for it. A code works
 * once: the screen is mounted again as soon as the exchange signs the person in, and asking again would fail.
 */
export function exchangeCasOnce(code: string, start: () => Promise<void>): Promise<void> {
  let exchange = casExchanges.get(code);
  if (!exchange) {
    exchange = start();
    casExchanges.set(code, exchange);
  }
  return exchange;
}

export function forgetCasExchanges(): void {
  casExchanges.clear();
  casFlows.clear();
}

export function markSessionEnded(): void {
  storage()?.setItem(SESSION_ENDED_KEY, '1');
}

export function clearSessionEnded(): void {
  storage()?.removeItem(SESSION_ENDED_KEY);
}

/** True when the last session ended without the person asking (a refresh that failed). */
export function hasSessionEnded(): boolean {
  return storage()?.getItem(SESSION_ENDED_KEY) === '1';
}

export interface CasFlow {
  mode: CasMode;
  /** Where the person was heading when they chose CAS; only used by the `login` mode. */
  returnTo: string | null;
}

/** Remember which CAS flow is about to leave the app, so that the callback page can tell them apart. */
export function rememberCasFlow(mode: CasMode, returnTo?: unknown): void {
  storage()?.setItem(CAS_FLOW_KEY, JSON.stringify({ mode, returnTo: safeReturnPath(returnTo), at: Date.now() }));
}

/** Forget the remembered CAS flow, once the callback page has used it. */
export function forgetCasFlow(): void {
  storage()?.removeItem(CAS_FLOW_KEY);
}

/** The remembered CAS flow. `null` when there is none, it is stale or it is malformed. */
export function readCasFlow(): CasFlow | null {
  const raw = storage()?.getItem(CAS_FLOW_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown; returnTo?: unknown; at?: unknown };
    if (parsed.mode !== 'login' && parsed.mode !== 'link') return null;
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > CAS_FLOW_MAX_AGE_MS) return null;
    return { mode: parsed.mode, returnTo: safeReturnPath(parsed.returnTo) };
  } catch {
    return null;
  }
}
