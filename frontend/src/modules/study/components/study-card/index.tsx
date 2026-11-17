// Adapted from SPHERE frontend/src/modules/pricing/components/collection-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a study instead of a collection: the chip is the matrix's formula ("a × b × c × d = N cells") instead of the
// number of pricings, then the latest run's pill and a mini bar of how its cells ended, and the Archived pill. The name is a
// real link stretched over the card (SPHERE navigated on click, which loses middle-click and the keyboard); the kebab of the
// composition cards (Archive or Restore, Delete) opens with the keyboard and closes on Escape.

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate } from '../../../../utils/format';
import type { Study, StudyCell, StudyRun } from '../../api/studiesApi';
import { definitionSize, formulaOf, plural } from '../../utils/studiesModel';
import { CellBar, StateChip } from '../study-state';

interface Props {
  study: Study;
  /** Where the card leads: the study's page. */
  to: string;
  /** The study's runs, once read; `undefined` while they load or when they can't be read. */
  runs?: readonly StudyRun[];
  /** The cells of the latest run, when they were read. */
  latestCells?: readonly StudyCell[];
  /** The kebab's entries: Archive or Restore, Delete. */
  menuItems?: Array<{ label: string; onClick: () => void; variant?: 'danger' }>;
}

export default function StudyCard({ study, to, runs, latestCells, menuItems = [] }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (event: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  const size = definitionSize(study.definition);
  const latest = runs?.reduce<StudyRun | undefined>(
    (best, run) => (!best || run.run_number > best.run_number ? run : best),
    undefined
  );
  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      aria-label={study.name}
      className="group relative flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors focus-within:border-tp-hairline-strong hover:border-tp-hairline-strong hover:shadow-elevation-2"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tp-cream">
          <svg
            className="h-4 w-4 text-tp-accent"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-tp-ink group-hover:text-tp-accent">
            <Link
              to={to}
              viewTransition
              className="cursor-pointer outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-tp-primary"
            >
              {study.name}
            </Link>
          </h3>
          <p className="truncate text-[11px] text-tp-steel">
            {study.description || `Created ${formatDate(study.created_at) ?? ''}`}
          </p>
        </div>
        {study.archived && (
          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            Archived
          </span>
        )}
        {menuItems.length > 0 && (
          <div ref={menuRef} className="relative z-10">
            <button
              type="button"
              aria-label={`Actions for ${study.name}`}
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
                className="absolute top-full right-0 z-10 mt-1 w-40 rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4"
              >
                {menuItems.map(item => (
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      item.onClick();
                      setMenuOpen(false);
                    }}
                    className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                      item.variant === 'danger'
                        ? 'text-red-700 hover:bg-red-50'
                        : 'text-tp-ink hover:bg-tp-surface'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-tp-steel">
        <span
          className="inline-flex items-center gap-1 rounded bg-tp-surface px-1.5 py-0.5"
          title={formulaOf(size)}
        >
          {`${size.cases} × ${size.engines} × ${size.settings} × ${size.seeds} = ${plural(size.cells, 'cell')}`}
        </span>
      </div>

      <div className="flex min-h-9 flex-col justify-end gap-1.5">
        {runs === undefined ? (
          <span className="text-[11px] text-tp-steel">Reading its runs…</span>
        ) : latest ? (
          <>
            <span className="flex flex-wrap items-center gap-2 text-[11px] text-tp-steel">
              <StateChip state={latest.state} label={`Run #${latest.run_number}`} />
              <span>
                {formatDate(latest.created_at) ?? ''}
                {runs.length > 1 ? ` · ${plural(runs.length, 'run')} in all` : ''}
              </span>
            </span>
            {latestCells && latestCells.length > 0 && <CellBar cells={latestCells} size="sm" />}
          </>
        ) : (
          <span className="text-[11px] text-tp-steel">Never run</span>
        )}
      </div>
    </motion.article>
  );
}
