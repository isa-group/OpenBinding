// Copied verbatim from SPHERE frontend/src/modules/beta/components/beta-gate/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

import type { ReactNode } from 'react';
import type { BetaFeatureKey } from '../../config/betaFeatures';
import { useBetaFeature } from '../../hooks/useBetaFeatures';

interface Props {
  feature: BetaFeatureKey;
  children: ReactNode;
  /** Rendered instead when beta features are off (nothing by default). */
  fallback?: ReactNode;
}

/** Renders its children only for users who turned on beta features. */
export default function BetaGate({ feature, children, fallback = null }: Props) {
  return <>{useBetaFeature(feature) ? children : fallback}</>;
}
