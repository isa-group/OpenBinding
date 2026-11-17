// Adapted from SPHERE frontend/src/modules/beta/hooks/useBetaFeatures.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: reads OpenBinding's `useAuth().user`; off until the profile carries the beta-features setting; `useBetaFeatureList`
// lists the registry for the settings section (other modules may import only hooks).

import { useAuth } from '../../auth/hooks/useAuth';
import { BETA_FEATURES, type BetaFeature, type BetaFeatureKey } from '../config/betaFeatures';

/** Whether the signed-in user turned on beta features in their settings. */
export function useBetaFeatures(): boolean {
  const { user } = useAuth();
  // The switch arrives with the gateway's beta-features setting; until a profile carries it, nobody sees beta features.
  const settings = (user as { settings?: { betaFeatures?: unknown } } | null)?.settings;
  return settings?.betaFeatures === true;
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
