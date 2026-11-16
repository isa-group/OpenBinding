// Adapted from SPHERE frontend/src/modules/auth/components/auth-layout/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's mark on the brand panel; the gradients are the theme's tokens instead of hex values; Back is a link
// (home, or the sign-in page from the password screens) instead of a button reading `document.referrer`, which a single-page
// navigation never changes; the split sits inside the public layout, under its header.

import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import AnimatedLogo from '../animated-logo';
import { fadeContainer } from './variants';

const PANEL_GRADIENT =
  'linear-gradient(155deg, var(--color-tp-sunshine-700) 0%, var(--color-tp-primary) 35%, var(--color-tp-primary-deep) 65%, var(--color-tp-ink) 100%)';
const PANEL_STRIPE =
  'linear-gradient(90deg, var(--color-tp-cream) 0%, var(--color-tp-yellow-saturated) 30%, var(--color-tp-sunshine-500) 55%, var(--color-tp-sunshine-700) 75%, var(--color-tp-primary) 100%)';
const MOBILE_STRIPE =
  'linear-gradient(90deg, var(--color-tp-primary) 0%, var(--color-tp-sunshine-700) 35%, var(--color-tp-sunshine-500) 55%, var(--color-tp-yellow-saturated) 75%, var(--color-tp-cream) 100%)';

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.3, duration: 0.4 }}
      className="absolute top-5 left-5 z-20 sm:top-6 sm:left-6"
    >
      <Link
        to={to}
        viewTransition
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2 text-sm font-medium text-tp-slate shadow-sm transition-all duration-200 hover:border-tp-hairline-strong hover:text-tp-ink"
      >
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        <span className="sr-only sm:not-sr-only">{label}</span>
      </Link>
    </motion.div>
  );
}

interface AuthLayoutProps {
  children: ReactNode;
  /** Where the Back link above the form goes: the home page by default. */
  backTo?: string;
  backLabel?: string;
}

/** SPHERE's split sign-in layout: the brand panel on the left (a banner on narrow screens) and the form on the right. */
export default function AuthLayout({
  children,
  backTo = '/',
  backLabel = 'Back',
}: AuthLayoutProps) {
  return (
    <div className="flex min-h-[46rem] w-full bg-tp-canvas">
      {/* ── Left panel: the brand gradient (50%) ── */}
      <div
        className="relative hidden w-1/2 overflow-hidden lg:block"
        style={{ background: PANEL_GRADIENT }}
        aria-hidden="true"
      >
        {/* Ambient floating orbs */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <motion.div
            className="absolute -top-24 -left-24 h-80 w-80 rounded-full bg-tp-sunshine-500/15"
            animate={{ y: [0, 25, 0], scale: [1, 1.06, 1] }}
            transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute -bottom-20 -left-10 h-64 w-64 rounded-full bg-tp-primary/10"
            animate={{ y: [0, -18, 0], scale: [1, 1.1, 1] }}
            transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut', delay: 1.5 }}
          />
          <motion.div
            className="absolute top-1/4 right-8 h-44 w-44 rounded-full bg-tp-yellow-saturated/15"
            animate={{ y: [0, 14, 0], x: [0, -10, 0] }}
            transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 2.5 }}
          />
          <motion.div
            className="absolute bottom-1/3 left-1/3 h-28 w-28 rounded-full bg-tp-cream-deeper/20"
            animate={{ y: [0, -12, 0] }}
            transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
          />
        </div>

        {/* Content */}
        <div className="relative z-10 flex h-full flex-col items-center justify-center p-10">
          <AnimatedLogo />
        </div>

        {/* Bottom stripe */}
        <div className="absolute right-0 bottom-0 left-0">
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 1.2, duration: 0.8, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="origin-left"
          >
            <div className="h-1.5 w-full" style={{ background: PANEL_STRIPE }} />
          </motion.div>
        </div>
      </div>

      {/* ── Right panel: the form (50%) ── */}
      <div className="relative flex w-full min-w-0 flex-1 flex-col lg:w-1/2">
        <BackLink to={backTo} label={backLabel} />

        {/* Mobile gradient header */}
        <div
          className="relative flex items-center justify-center px-6 pt-16 pb-8 sm:px-8 lg:hidden"
          style={{ background: PANEL_GRADIENT }}
          aria-hidden="true"
        >
          <AnimatedLogo className="scale-75" />
        </div>

        {/* Form area */}
        <div className="flex flex-1 items-center justify-center px-6 py-10 sm:px-10 lg:px-12">
          <motion.div
            variants={fadeContainer}
            initial="hidden"
            animate="show"
            className="w-full max-w-105"
          >
            {children}
          </motion.div>
        </div>

        {/* Mobile bottom stripe */}
        <div className="block lg:hidden" aria-hidden="true">
          <div className="h-1.5 w-full" style={{ background: MOBILE_STRIPE }} />
        </div>
      </div>
    </div>
  );
}
