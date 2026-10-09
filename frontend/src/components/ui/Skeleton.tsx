import './Skeleton.css';

interface SkeletonProps {
  /** `card` 148px, `panel` 220px, `tile` 64px. */
  variant?: 'card' | 'panel' | 'tile';
}

/** A grey placeholder that pulses (and stays still for people who ask for less motion). */
export function Skeleton({ variant = 'card' }: SkeletonProps) {
  return <div className={`ui-skeleton ui-skeleton-${variant}`} aria-hidden="true" />;
}
