import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  afterSignInTarget,
  clearSessionEnded,
  clearSignInNote,
  hasRecentSignIn,
  hasSessionEnded,
  markSessionEnded,
  noteSignInStarted,
  safeReturnPath,
} from './authFlow';

describe('safeReturnPath', () => {
  it.each([
    '/me/settings?section=plan',
    '/problems/isa-demo/checkout-flow/versions?from=1&to=2',
    '/runs/isa-demo/6b0c7f9e-0000-4000-8000-000000000001',
    '/runs/new?org=isa-demo&problem=checkout-flow&revision=2',
    '/studies/isa-demo/engines-compared/front',
    '/studies/new?org=isa-demo',
    '/admin/moderation',
    '/notifications',
    '/engines/bim/edge/1.0.0',
    '/orgs/join/c0de0000c0de0000',
    '/me/orgs',
    '/compositions',
    '/compositions?kind=workflow&q=fleet&page=2',
    '/compositions/lab-other/fleet-routing',
    '/compositions/lab-other/fleet-routing?version=1.2.0&fork=1',
    '/compositions/new?org=isa-demo',
    '/p/6b0c7f9e-0000-4000-8000-000000000001',
    '/editor',
    '/editor?source=isa-demo%2Forder-desk&version=1.2.0#composition=N4Ig',
    '/problem-editor?org=isa-demo&problem=checkout-flow&revision=2&carry=1',
  ])('lets a sign-in return to %s', path => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each([
    '/pricing',
    '/account',
    '/authentication',
    '/appx',
    '/app',
    '/app/account',
    '/problemsx',
    '/runs',
    '//evil.example/app',
    '/\\evil.example',
    'https://evil.example/app',
    'app',
    '',
    undefined,
    null,
    42,
    { path: '/app' },
    '/c/x/y',
    '//compositions/x/y',
    '/compositionsx',
    '/px',
    '/c',
    '/editorx',
    '/editor/x',
    '/problem-editorx',
    '/workbench',
  ])('refuses %j', value => {
    expect(safeReturnPath(value)).toBeNull();
  });

  it('falls back to the workspace', () => {
    expect(afterSignInTarget('/pricing')).toBe('/');
    expect(afterSignInTarget(undefined)).toBe('/');
    expect(afterSignInTarget('/me/settings')).toBe('/me/settings');
  });

  it('returns to the page of a composition, with its query, so the fork asked for there opens', () => {
    expect(afterSignInTarget('/compositions/lab-other/fleet-routing?version=1.2.0&fork=1')).toBe(
      '/compositions/lab-other/fleet-routing?version=1.2.0&fork=1'
    );
    expect(afterSignInTarget('/compositions?kind=workflow')).toBe('/compositions?kind=workflow');
    expect(afterSignInTarget('/c/lab-other')).toBe('/');
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
