// Adapted from SPHERE frontend/src/modules/beta/hooks/useBetaFeatures.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE reads the switch from its user's settings; OpenBinding's profile does not carry it, so it is read once per
// account from `GET /v1/users/me/settings/beta-features` and kept for the session, and Settings → Beta features announces a
// change (`BETA_FEATURES_CHANGED`) instead of reloading the profile; `useBetaFeatureStatus` says whether it is known yet, so a
// beta tab named in the address waits for it instead of answering 404; `useBetaFeatureList` lists the registry for the
// settings section (other modules may import only hooks).

import { useEffect, useSyncExternalStore } from 'react';
import { apiClient } from '../../core/api/http';
import { useAuth } from '../../auth/hooks/useAuth';
import { BETA_FEATURES, type BetaFeature, type BetaFeatureKey } from '../config/betaFeatures';

/** The window event Settings → Beta features dispatches after it saved the switch (`detail: { enabled }`). */
export const BETA_FEATURES_CHANGED = 'openbinding:beta-features-changed';

interface Known {
  /** The account the switch was read for. */
  account: string;
  enabled: boolean;
}

let known: Known | null = null;
let reading: { account: string; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the switch of `account` once; a failed read counts as off (a beta feature is never shown by mistake). */
function readFor(account: string): void {
  if (known?.account === account || reading?.account === account) return;
  const promise = apiClient
    .request<{ enabled?: boolean }>('/v1/users/me/settings/beta-features')
    .then(
      answer => answer?.enabled === true,
      () => false
    )
    .then(enabled => {
      if (reading?.account !== account) return;
      known = { account, enabled };
      reading = null;
      notify();
    });
  reading = { account, promise };
}

if (typeof window !== 'undefined') {
  window.addEventListener(BETA_FEATURES_CHANGED, event => {
    const enabled = (event as CustomEvent<{ enabled?: boolean }>).detail?.enabled === true;
    if (known) known = { ...known, enabled };
    notify();
  });
}

/** Whether the signed-in user's switch is on, off, or not read yet. */
export function useBetaFeatureStatus(): 'on' | 'off' | 'unknown' {
  const { user } = useAuth();
  const account = user?.id ?? null;
  useEffect(() => {
    if (account) readFor(account);
  }, [account]);
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!account) return 'off';
      if (known?.account !== account) return 'unknown';
      return known.enabled ? 'on' : 'off';
    },
    () => 'off'
  );
}

/** Whether the signed-in user turned on beta features in their settings. */
export function useBetaFeatures(): boolean {
  return useBetaFeatureStatus() === 'on';
}

/**
 * Whether a registered beta feature is visible to the signed-in user. Every beta
 * feature follows the same switch; the key ties the caller to `BETA_FEATURES`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useBetaFeature(_feature: BetaFeatureKey): boolean {
  return useBetaFeatures();
}

export type { BetaFeature, BetaFeatureKey };

/** Every registered beta feature, for the settings section that lists them. */
export function useBetaFeatureList(): Array<[BetaFeatureKey, BetaFeature]> {
  return Object.entries(BETA_FEATURES) as Array<[BetaFeatureKey, BetaFeature]>;
}

/** Forget what was read (tests). */
export function forgetBetaFeatures(): void {
  known = null;
  reading = null;
  notify();
}
