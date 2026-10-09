import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterSignInTarget, casFlowFor, clearSessionEnded, clearSignInNote, exchangeCasOnce, forgetCasExchanges, forgetCasFlow, hasRecentSignIn,
  hasSessionEnded, markSessionEnded, noteSignInStarted, readCasFlow, rememberCasFlow, safeReturnPath,
} from './authFlow';

describe('safeReturnPath', () => {
  it.each([
    '/app',
    '/app/account',
    '/app/isa-demo/atlas/jobs?tab=queue',
    '/invitations/accept',
    '/invitations/accept?token=obi_abc_def',
  ])('lets a sign-in return to %s', (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each([
    '/pricing', '/account', '/login', '/appx', '//evil.example/app', '/\\evil.example', 'https://evil.example/app',
    'app', '', undefined, null, 42, { path: '/app' },
  ])('refuses %j', (value) => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it('falls back to the workspace', () => {
    expect(afterSignInTarget('/pricing')).toBe('/app');
    expect(afterSignInTarget(undefined)).toBe('/app');
    expect(afterSignInTarget('/app/account')).toBe('/app/account');
  });
});

describe('session ended flag', () => {
  beforeEach(() => {
    clearSessionEnded();
  });

  it('is set by a session that ended and cleared by the next sign-in', () => {
    expect(hasSessionEnded()).toBe(false);
    markSessionEnded();
    expect(hasSessionEnded()).toBe(true);
    clearSessionEnded();
    expect(hasSessionEnded()).toBe(false);
  });
});

describe('sign-in note', () => {
  beforeEach(() => {
    clearSignInNote();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says a sign-in just finished, for half a minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    expect(hasRecentSignIn()).toBe(false);
    noteSignInStarted();
    expect(hasRecentSignIn()).toBe(true);
    vi.setSystemTime(new Date('2026-10-09T10:00:29Z'));
    expect(hasRecentSignIn()).toBe(true);
    vi.setSystemTime(new Date('2026-10-09T10:00:31Z'));
    expect(hasRecentSignIn()).toBe(false);
  });

  it('can be cleared, and ignores garbage', () => {
    noteSignInStarted();
    clearSignInNote();
    expect(hasRecentSignIn()).toBe(false);
    sessionStorage.setItem('openbinding-sign-in-started', 'soon');
    expect(hasRecentSignIn()).toBe(false);
  });
});

describe('CAS exchange and flow, kept per code', () => {
  beforeEach(() => {
    forgetCasFlow();
    forgetCasExchanges();
  });

  it('runs an exchange once however many screens ask for it', async () => {
    const start = vi.fn().mockResolvedValue(undefined);

    await Promise.all([exchangeCasOnce('code-1', start), exchangeCasOnce('code-1', start)]);
    await exchangeCasOnce('code-1', start);
    await exchangeCasOnce('code-2', start);

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('hands every caller the same refusal', async () => {
    const start = vi.fn().mockRejectedValue(new Error('spent'));

    await expect(exchangeCasOnce('code-1', start)).rejects.toThrow('spent');
    await expect(exchangeCasOnce('code-1', start)).rejects.toThrow('spent');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps the flow against its code after the memory is forgotten', () => {
    rememberCasFlow('login', '/app/account');
    expect(casFlowFor('code-1')).toEqual({ mode: 'login', returnTo: '/app/account' });
    forgetCasFlow();

    expect(casFlowFor('code-1')).toEqual({ mode: 'login', returnTo: '/app/account' });
    expect(casFlowFor('code-2')).toBeNull();
    expect(casFlowFor(null)).toBeNull();
  });
});

describe('CAS flow memory', () => {
  beforeEach(() => {
    forgetCasFlow();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('remembers the mode and a safe return path, and nothing else', () => {
    rememberCasFlow('login', '/app/org/project');
    expect(readCasFlow()).toEqual({ mode: 'login', returnTo: '/app/org/project' });
    expect(JSON.stringify(sessionStorage)).not.toMatch(/token/i);
  });

  it('drops a return path that is not safe', () => {
    rememberCasFlow('login', 'https://evil.example');
    expect(readCasFlow()).toEqual({ mode: 'login', returnTo: null });
  });

  it('is empty once forgotten', () => {
    rememberCasFlow('link');
    forgetCasFlow();
    expect(readCasFlow()).toBeNull();
  });

  it('stops being believed after half an hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    rememberCasFlow('link');
    vi.setSystemTime(new Date('2026-10-09T10:29:00Z'));
    expect(readCasFlow()?.mode).toBe('link');
    vi.setSystemTime(new Date('2026-10-09T10:31:00Z'));
    expect(readCasFlow()).toBeNull();
  });

  it('ignores a malformed entry', () => {
    sessionStorage.setItem('openbinding-cas-flow', '{not json');
    expect(readCasFlow()).toBeNull();
    sessionStorage.setItem('openbinding-cas-flow', JSON.stringify({ mode: 'admin', at: Date.now() }));
    expect(readCasFlow()).toBeNull();
  });
});
