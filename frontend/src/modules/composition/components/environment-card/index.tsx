// Adapted from SPHERE frontend/src/modules/pricing/components/collection-card/index.tsx (revision fc776b4d),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an environment of a composition instead of a collection, the way OpenBinding's study card already adapts the
// recipe: the name is a real link stretched over the card (to the environment's detail, `?environment=<slug>`), the kebab
// (Edit, Delete; ADMIN) opens with the keyboard and closes on Escape. The chips say the version in effect with its value
// badge, the adoption number, its upstream badge (open events of the version in effect, or a newer version that resolved
// one and is not adopted here), when and by whom it was adopted, and the operator; "Adopt" is the card's own primary action.

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CompositionEnvironmentView } from '../../../core/api/types';
import { UpstreamBadge } from '../../../core/components/upstream-badge';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { adoptedText } from '../../utils/environments';

interface Props {
  environment: CompositionEnvironmentView;
  /** Where the card leads: the environment's detail on the Operation tab. */
  to: string;
  /** Adopt a version here; absent when the reader may not adopt in this environment. */
  onAdopt?: () => void;
  /** The kebab's entries (ADMIN): Edit, Delete. */
  menuItems?: Array<{ label: string; onClick: () => void; variant?: 'danger' }>;
}

export default function EnvironmentCard({ environment, to, onAdopt, menuItems = [] }: Props) {
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

  const inEffect = environment.inEffect;
  const operator = environment.operator;
  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      aria-label={`Environment ${environment.name}`}
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
              d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium text-tp-ink group-hover:text-tp-accent">
            <Link
              to={to}
              className="block cursor-pointer truncate leading-6 outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-tp-primary"
            >
              {environment.name}
            </Link>
          </h3>
          <p className="truncate font-mono text-[11px] text-tp-steel">{environment.slug}</p>
        </div>
        {menuItems.length > 0 && (
          <div ref={menuRef} className="relative z-10">
            <button
              type="button"
              aria-label={`Actions for ${environment.name}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-6 min-w-6 cursor-pointer items-center justify-center rounded text-tp-steel opacity-0 transition-all group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-tp-surface hover:text-tp-ink focus:opacity-100 aria-expanded:opacity-100 max-sm:opacity-100"
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
        {inEffect ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded bg-tp-primary/10 px-1.5 py-0.5 font-medium text-tp-accent">
              In effect
              <span className="font-mono">{inEffect.version.label}</span>
            </span>
            {inEffect.evaluation && (
              <ValueBadge status={inEffect.evaluation.valuesStatus} compact />
            )}
            <span className="rounded bg-tp-surface px-1.5 py-0.5">
              Adoption #{inEffect.adoption}
            </span>
            <UpstreamBadge upstream={environment.upstream} to={to} />
          </>
        ) : (
          <span className="rounded bg-tp-surface px-1.5 py-0.5">Nothing adopted yet</span>
        )}
      </div>

      <div className="flex min-h-9 flex-col justify-end gap-1 text-[11px] text-tp-steel">
        {inEffect && <span>{adoptedText(inEffect)}</span>}
        <span>
          {operator
            ? `Operator: ${operator.displayName}${operator.member ? '' : ' (no longer a member)'}`
            : 'No operator'}
          {' · '}
          {environment.adoptRole === 'MEMBER' ? 'Members adopt' : 'Admins adopt'}
        </span>
      </div>

      {onAdopt && (
        <div className="relative z-10 flex justify-end">
          <button
            type="button"
            onClick={onAdopt}
            className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-tp-primary px-3 text-xs font-medium text-white transition-colors hover:bg-tp-primary/90"
          >
            Adopt…
          </button>
        </div>
      )}
    </motion.article>
  );
}
