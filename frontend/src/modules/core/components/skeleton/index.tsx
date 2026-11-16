// Pattern only, after SPHERE frontend/src/modules/core/components/skeletons/pricing-card-skeleton.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's skeleton colours and radius (rounded-xl on the hairline grey); the `ui-skeleton` class stays as the
// hook the QA gallery waits on.

interface SkeletonProps {
  /** `card` 148px, `panel` 220px, `tile` 64px. */
  variant?: 'card' | 'panel' | 'tile';
}

const HEIGHTS = { card: 'h-[148px]', panel: 'h-[220px]', tile: 'h-16' } as const;

/** A grey placeholder that pulses (and stays still for people who ask for less motion). */
export function Skeleton({ variant = 'card' }: SkeletonProps) {
  return (
    <div
      className={`ui-skeleton ui-skeleton-${variant} w-full animate-pulse rounded-xl bg-tp-hairline-soft motion-reduce:animate-none ${HEIGHTS[variant]}`}
      aria-hidden="true"
    />
  );
}
