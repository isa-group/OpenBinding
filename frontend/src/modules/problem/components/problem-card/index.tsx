// Adapted from SPHERE frontend/src/modules/pricing/components/pricing-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a problem instead of a pricing: the chips say whether it is ready to run (it has a sealed version) and where its
// latest version came from, and the line under them how many versions it has and the latest one with its date. The name is a
// real link stretched over the card (SPHERE navigated on click, which loses middle-click and the keyboard); the kebab holds
// links as well as actions, opens with the keyboard, closes on Escape and shows on focus as on hover.

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProblemView } from '../../api/problemsApi';
import { ORIGIN_LABELS } from '../../types';
import { plural } from '../../utils/problemsModel';
import { formatDate } from '../../../../utils/format';

/** An entry of the card's kebab: a link, or an action. */
export interface ProblemMenuItem {
  label: string;
  /** Names the entry for assistive technology when the label alone is ambiguous. */
  ariaLabel?: string;
  to?: string;
  onClick?: () => void;
  variant?: 'danger' | 'default';
}

interface Props {
  data: Pick<ProblemView, 'name' | 'slug' | 'description' | 'latest_revision' | 'revision_count'>;
  /** Where the card leads: the problem's page. */
  to: string;
  menuItems?: ProblemMenuItem[];
}

export default function ProblemCard({ data, to, menuItems = [] }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: globalThis.MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const latest = data.latest_revision ?? null;
  const itemClass = (item: ProblemMenuItem) =>
    `flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
      item.variant === 'danger' ? 'text-red-700 hover:bg-red-50' : 'text-tp-ink hover:bg-tp-surface'
    }`;

  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      aria-label={data.name}
      className="group relative rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors focus-within:border-tp-hairline-strong hover:border-tp-hairline-strong hover:shadow-elevation-2"
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="min-w-0 text-sm font-medium text-tp-ink group-hover:text-tp-accent">
            <Link
              to={to}
              className="block cursor-pointer truncate py-1 outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-tp-primary"
            >
              {data.name}
            </Link>
          </h3>
          <p className="line-clamp-2 text-[11px] text-tp-steel">
            {data.description || 'No description.'}
          </p>
        </div>

        {menuItems.length > 0 && (
          <div ref={menuRef} className="relative z-10">
            <button
              type="button"
              aria-label={`Actions for ${data.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-6 cursor-pointer items-center justify-center rounded text-tp-steel opacity-0 transition-all group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-tp-surface hover:text-tp-ink focus:opacity-100 aria-expanded:opacity-100 max-sm:opacity-100"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z"
                />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute top-full right-0 z-10 mt-1 w-47 rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
              >
                {menuItems.map(item =>
                  item.to ? (
                    <Link
                      key={item.label}
                      role="menuitem"
                      to={item.to}
                      aria-label={item.ariaLabel}
                      onClick={() => setMenuOpen(false)}
                      className={itemClass(item)}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      aria-label={item.ariaLabel}
                      onClick={event => {
                        event.stopPropagation();
                        item.onClick?.();
                        setMenuOpen(false);
                      }}
                      className={itemClass(item)}
                    >
                      {item.label}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-tp-steel">
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${latest ? 'bg-emerald-50 text-emerald-800' : 'bg-tp-surface text-tp-slate'}`}
        >
          {latest ? 'Ready to run' : 'No version yet'}
        </span>
        {latest && (
          <span
            className="rounded bg-tp-surface px-1.5 py-0.5"
            title="Where its latest version came from"
          >
            {ORIGIN_LABELS[latest.origin]}
          </span>
        )}
      </div>
      <p className="mt-2 text-[11px] text-tp-steel">
        {plural(data.revision_count, 'version')} ·{' '}
        {latest
          ? `latest v${latest.revision} · ${formatDate(latest.created_at) ?? '—'}`
          : 'latest none yet'}
      </p>
    </motion.article>
  );
}
