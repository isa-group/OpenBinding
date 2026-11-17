// Adapted from SPHERE frontend/src/modules/presentation/pages/research/components/timeline.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the items are the papers of OpenBinding's executable corpus, with the corpus each one feeds; the variant fills
// are tokens (`bg-tp-*`) instead of hex values, the card arrows are rotated squares drawn with utilities instead of inline
// hex borders, and the shadows are the elevation tokens; awards are not brought (no paper has one); the timeline is an
// ordered list, the date a `<time>`, and the motion stays still for people who ask for less.

import { motion, MotionConfig, type Variants } from 'framer-motion';
import { type ReactNode } from 'react';
import { FaStar } from 'react-icons/fa';

export interface TimelineItem {
  date: string;
  title: string;
  subtitle: string;
  text: string[];
  icon: ReactNode;
  href: string;
  variant: 'journal' | 'proceedings' | 'demo';
}

const variantColors: Record<TimelineItem['variant'], string> = {
  journal: 'bg-tp-primary-deep',
  proceedings: 'bg-tp-primary',
  demo: 'bg-tp-sunshine-800',
};

const cardVariants: Variants = {
  hiddenLeft: { opacity: 0, x: -50, filter: 'blur(4px)' },
  hiddenRight: { opacity: 0, x: 50, filter: 'blur(4px)' },
  visible: {
    opacity: 1,
    x: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  },
};

const iconVariants: Variants = {
  hidden: { scale: 0, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: { type: 'spring', stiffness: 300, damping: 22, delay: 0.2 },
  },
};

const dateVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, delay: 0.35 },
  },
};

const CARD =
  'rounded-2xl border border-tp-hairline-strong bg-tp-canvas p-5 shadow-elevation-2 transition-all duration-300 hover:border-tp-primary/40 hover:shadow-elevation-3';

function CardContent({ item }: { item: TimelineItem }) {
  return (
    <>
      <a href={item.href} target="_blank" rel="noopener noreferrer" className="cursor-pointer">
        <h3 className="text-base leading-snug font-bold text-tp-ink underline decoration-tp-primary/30 underline-offset-2 transition-colors hover:text-tp-accent md:text-lg">
          {item.title}
        </h3>
      </a>
      <p className="mt-2 text-xs leading-relaxed text-tp-slate md:text-sm">{item.subtitle}</p>
      <div className="mt-2.5 space-y-0.5">
        {item.text.map(line => (
          <p key={line} className="text-xs text-tp-slate md:text-sm">
            {line}
          </p>
        ))}
      </div>
    </>
  );
}

/** The small arrow of a desktop card, pointing at the line. */
function Arrow({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      aria-hidden="true"
      className={`absolute top-1/2 hidden h-4 w-4 -translate-y-1/2 rotate-45 bg-tp-canvas md:block ${
        side === 'left'
          ? '-right-2 border-t border-r border-tp-hairline-strong'
          : '-left-2 border-b border-l border-tp-hairline-strong'
      }`}
    />
  );
}

/* ═══════════════════════════════════════════════════════════════
   DESKTOP CARD (alternating left / right)
   ═══════════════════════════════════════════════════════════════ */
function DesktopTimelineCard({ item, side }: { item: TimelineItem; side: 'left' | 'right' }) {
  const isLeft = side === 'left';
  const card = (
    <motion.div
      variants={cardVariants}
      initial={isLeft ? 'hiddenLeft' : 'hiddenRight'}
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      className="relative w-full max-w-125"
    >
      <div className={CARD}>
        <CardContent item={item} />
      </div>
      <Arrow side={side} />
    </motion.div>
  );
  const date = (
    <motion.time
      variants={dateVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true }}
      dateTime={item.date}
      className="self-center text-sm font-semibold whitespace-nowrap text-tp-ink"
    >
      {item.date}
    </motion.time>
  );

  return (
    <div className="relative grid grid-cols-[1fr_64px_1fr] items-center">
      <div className={`col-start-1 flex justify-end ${isLeft ? '' : 'pr-6'}`}>
        {isLeft ? card : date}
      </div>

      <div className="col-start-2 flex justify-center">
        <motion.div
          variants={iconVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          className={`relative z-10 flex h-11 w-11 items-center justify-center rounded-full border-[3px] border-tp-canvas text-tp-on-primary shadow-[0_0_0_3px_var(--color-tp-primary)] md:h-12 md:w-12 ${variantColors[item.variant]}`}
        >
          {item.icon}
        </motion.div>
      </div>

      <div className={`col-start-3 flex justify-start ${isLeft ? 'pl-6' : ''}`}>
        {isLeft ? date : card}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MOBILE CARD (single column, line on left)
   ═══════════════════════════════════════════════════════════════ */
function MobileTimelineCard({ item }: { item: TimelineItem }) {
  return (
    <div className="relative grid grid-cols-[40px_1fr] items-start gap-3">
      <div className="flex justify-center pt-1">
        <motion.div
          variants={iconVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          className={`relative z-10 flex h-9 w-9 items-center justify-center rounded-full border-[3px] border-tp-canvas text-tp-on-primary shadow-[0_0_0_2.5px_var(--color-tp-primary)] ${variantColors[item.variant]}`}
        >
          {item.icon}
        </motion.div>
      </div>

      <motion.div
        variants={cardVariants}
        initial="hiddenRight"
        whileInView="visible"
        viewport={{ once: true, amount: 0.15 }}
        className="relative w-full pb-2"
      >
        <div className="rounded-xl border border-tp-hairline-strong bg-tp-canvas p-4 shadow-elevation-1">
          <time dateTime={item.date} className="mb-2 block text-[11px] font-semibold text-tp-steel">
            {item.date}
          </time>
          <CardContent item={item} />
        </div>
      </motion.div>
    </div>
  );
}

function EndCap({ size }: { size: 'desktop' | 'mobile' }) {
  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      whileInView={{ scale: 1, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      aria-hidden="true"
      className={`relative z-10 flex items-center justify-center rounded-full border-[3px] border-tp-canvas bg-tp-primary text-tp-on-primary shadow-elevation-3 ${
        size === 'desktop'
          ? 'h-11 w-11 shadow-[0_0_0_3px_var(--color-tp-primary)]'
          : 'h-9 w-9 shadow-[0_0_0_2.5px_var(--color-tp-primary)]'
      }`}
    >
      <FaStar className={size === 'desktop' ? 'h-5 w-5' : 'h-4 w-4'} />
    </motion.div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TIMELINE (exported)
   ═══════════════════════════════════════════════════════════════ */
export default function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));

  // Things that fly in stay where they are for people who ask for less motion.
  return (
    <MotionConfig reducedMotion="user">
      <div className="relative w-full">
        {/* ═══ Desktop ═══ */}
        <div className="hidden md:block">
          <div className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-tp-hairline-strong" />
          <div className="absolute top-0 bottom-0 left-1/2 w-0.75 -translate-x-1/2 rounded-full bg-linear-to-b from-tp-primary via-tp-primary to-tp-primary/20" />

          <ol className="space-y-14" aria-label={label}>
            {sorted.map((item, index) => (
              <li key={item.href}>
                <DesktopTimelineCard item={item} side={index % 2 === 0 ? 'left' : 'right'} />
              </li>
            ))}
          </ol>

          <div className="relative mt-14 flex justify-center">
            <EndCap size="desktop" />
          </div>
        </div>

        {/* ═══ Mobile ═══ */}
        <div className="md:hidden">
          <div className="absolute top-0 bottom-0 left-4.75 w-0.75 rounded-full bg-linear-to-b from-tp-primary via-tp-primary to-tp-primary/20" />

          <ol className="space-y-6" aria-label={label}>
            {sorted.map(item => (
              <li key={item.href}>
                <MobileTimelineCard item={item} />
              </li>
            ))}
          </ol>

          <div className="relative mt-6 flex justify-start pl-1.5">
            <EndCap size="mobile" />
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
