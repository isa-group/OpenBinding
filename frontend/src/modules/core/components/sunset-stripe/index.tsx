// Adapted from SPHERE frontend/src/modules/core/components/sunset-stripe.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gradient stops are the theme's tokens instead of hex values, so the stripe follows the brand palette.

export default function SunsetStripeBand() {
  return (
    <div
      className="w-full"
      aria-hidden="true"
      style={{
        height: '8px',
        background:
          'linear-gradient(90deg, var(--color-tp-primary) 0%, var(--color-tp-sunshine-700) 35%, var(--color-tp-sunshine-500) 55%, var(--color-tp-yellow-saturated) 75%, var(--color-tp-cream) 100%)',
      }}
    />
  );
}
