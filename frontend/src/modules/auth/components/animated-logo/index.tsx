// Adapted from SPHERE frontend/src/modules/auth/components/animated-logo/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's mark (a binding: an input, two candidates, the chosen binding and its verdict) instead of SPHERE's
// orbiting sphere, drawn in on arrival with a token travelling the chosen path; the wordmark is OpenBinding's; white and
// translucent white only, so it reads on either brand palette.

import { motion } from 'framer-motion';

const DRAW = { duration: 0.7, ease: 'easeOut' } as const;

/** The binding diagram of OpenBinding, drawn in once and then kept alive by a token that walks the chosen binding. */
export default function AnimatedLogo({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-col items-center gap-6 text-white ${className}`}>
      <div className="relative h-36 w-64 sm:h-44 sm:w-76">
        <svg
          viewBox="0 0 260 150"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-full w-full"
          aria-hidden="true"
        >
          {/* The verdict's glow */}
          <motion.circle
            cx="236"
            cy="75"
            r="16"
            fill="currentColor"
            stroke="none"
            initial={{ opacity: 0, scale: 1 }}
            animate={{ opacity: [0.08, 0.22, 0.08], scale: [1, 1.3, 1] }}
            transition={{ delay: 1.6, duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}
          />

          {/* The input */}
          <motion.rect
            x="8"
            y="60"
            width="44"
            height="30"
            rx="8"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={DRAW}
          />
          <motion.path
            d="M52 75h24M76 75v-32M76 75v32"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ ...DRAW, delay: 0.3 }}
          />

          {/* Two candidates */}
          <motion.rect
            x="76"
            y="28"
            width="44"
            height="30"
            rx="8"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ ...DRAW, delay: 0.5 }}
          />
          <motion.rect
            x="76"
            y="92"
            width="44"
            height="30"
            rx="8"
            strokeOpacity="0.6"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ ...DRAW, delay: 0.6 }}
          />
          <motion.path
            d="M120 43h20v32M120 107h20V75M140 75h18"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ ...DRAW, delay: 0.8 }}
          />

          {/* The chosen binding */}
          <motion.rect
            x="158"
            y="60"
            width="44"
            height="30"
            rx="8"
            strokeDasharray="4 3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1, duration: 0.5 }}
          />
          <motion.path
            d="M202 75h18"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ ...DRAW, delay: 1.2 }}
          />

          {/* Its verdict */}
          <motion.circle
            cx="236"
            cy="75"
            r="14"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ ...DRAW, delay: 1.3 }}
          />
          <motion.path
            d="M230 75l4 4 8-8"
            strokeWidth="2"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.4, ease: 'easeOut', delay: 1.8 }}
          />

          {/* A token walking the chosen binding */}
          <motion.circle
            r="3"
            fill="currentColor"
            stroke="none"
            initial={{ opacity: 0, cx: 30, cy: 75 }}
            animate={{
              opacity: [0, 1, 1, 1, 1, 1, 1, 0],
              cx: [30, 76, 76, 120, 140, 140, 180, 222],
              cy: [75, 75, 43, 43, 43, 75, 75, 75],
            }}
            transition={{
              delay: 2,
              duration: 4,
              repeat: Infinity,
              repeatDelay: 1.2,
              ease: 'linear',
            }}
          />
        </svg>
      </div>

      {/* Wordmark */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6, duration: 0.5 }}
        className="flex flex-col items-center gap-1"
      >
        <span className="font-display text-5xl tracking-wide text-white">OpenBinding</span>
        <span className="w-full text-center text-sm tracking-[0.25em] text-white/70 uppercase">
          Deterministic QoS binding
        </span>
      </motion.div>
    </div>
  );
}
