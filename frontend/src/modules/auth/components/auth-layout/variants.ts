// Copied verbatim from SPHERE frontend/src/modules/auth/components/auth-layout/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the two motion variants live in a module of their own, so the layout file exports only its component.

import type { Variants } from 'framer-motion';

/** The form column: its children fade in one after another. */
export const fadeContainer: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.15 },
  },
};

/** One block of a form, rising into place. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' } },
};
