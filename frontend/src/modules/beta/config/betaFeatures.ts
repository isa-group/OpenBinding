// Adapted from SPHERE frontend/src/modules/beta/config/betaFeatures.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's registry: the organization Connections tab (F3, F8) instead of SPHERE's Services tab.

export interface BetaFeature {
  /** Part of OpenBinding where the feature shows up, e.g. 'ORBIT' or 'Composition editor'. */
  area: string;
  name: string;
  description: string;
}

/**
 * Features that only users who turned on Settings → Beta features can see.
 *
 * To add one, register it here and wrap its UI in `<BetaGate feature="...">` (or
 * check `useBetaFeature('...')`); guard its API routes with `requireBetaFeatures`.
 * When it graduates, delete its entry: the compiler then points at every gate left.
 *
 * Example:
 *   'orbit-voice-input': {
 *     area: 'ORBIT',
 *     name: 'Voice input',
 *     description: 'Dictate your messages to ORBIT.',
 *   },
 */
export const BETA_FEATURES = {
  'organization-connections': {
    area: 'Organizations',
    name: 'Connections',
    description: "A Connections tab with the organization's links to SPHERE and SPACE.",
  },
} satisfies Record<string, BetaFeature>;

export type BetaFeatureKey = keyof typeof BETA_FEATURES;
