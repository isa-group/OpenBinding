// Adapted from SPHERE frontend/src/modules/core/components/skeleton-theme-provider/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: light only (no mode context), the colours are the theme tokens, and the skeleton stylesheet is imported here.

import { SkeletonTheme } from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import { type ReactNode } from 'react';

export default function SkeletonThemeProvider({ children }: { children: ReactNode }) {
  return (
    <SkeletonTheme
      baseColor="var(--color-tp-hairline-soft)"
      highlightColor="var(--color-tp-surface)"
      borderRadius={12}
    >
      {children}
    </SkeletonTheme>
  );
}
