// Pattern only, after SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's card-page tabs: an underline that slides between tabs (framer-motion `layoutId`), and rounded
// pills below `sm`; OpenBinding's keyboard model (arrows, Home, End) and its tab/panel wiring are kept.

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';

export interface TabBarItem {
  id: string;
  label: string;
  /** A number shown beside the label; `…` while it is still unknown. */
  count?: number | string;
}

interface TabBarProps {
  items: readonly TabBarItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Ties the tabs to their panel; unique on the page. */
  prefix: string;
}

/** Tabs that the caller drives (from the address, say): arrow keys, Home and End select and move focus. */
export function TabBar({ items, value, onChange, ariaLabel, prefix }: TabBarProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (index: number) => {
    const target = items[(index + items.length) % items.length];
    if (!target) return;
    onChange(target.id);
    buttons.current[items.indexOf(target)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const keys: Record<string, number> = {
      ArrowRight: index + 1,
      ArrowLeft: index - 1,
      Home: 0,
      End: items.length - 1,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    move(keys[event.key]);
  };

  return (
    <div
      className="ui-tabbar flex gap-1 overflow-x-auto border-b border-tp-hairline max-sm:gap-1.5 max-sm:border-b-0 max-sm:pb-1"
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={node => {
              buttons.current[index] = node;
            }}
            id={`${prefix}-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${prefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={event => onKeyDown(event, index)}
            className={`relative inline-flex shrink-0 cursor-pointer items-center gap-1.5 px-3 py-2.5 text-sm whitespace-nowrap transition-colors max-sm:rounded-full max-sm:border max-sm:px-3 max-sm:py-1.5 ${
              selected
                ? 'font-medium text-tp-ink max-sm:border-tp-primary/30 max-sm:bg-tp-primary/10 max-sm:text-tp-accent'
                : 'text-tp-slate hover:text-tp-ink max-sm:border-tp-hairline'
            }`}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="ui-tabbar-count rounded-full bg-tp-surface px-1.5 text-[11px] text-tp-steel">
                {item.count}
              </span>
            )}
            {selected && (
              <motion.span
                layoutId={`${prefix}-underline`}
                className="absolute inset-x-0 -bottom-px h-0.5 bg-tp-primary max-sm:hidden"
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel the selected tab controls. */
export function TabPanel({
  prefix,
  active,
  children,
}: {
  prefix: string;
  active: string;
  children: ReactNode;
}) {
  return (
    <div
      id={`${prefix}-panel`}
      role="tabpanel"
      aria-labelledby={`${prefix}-tab-${active}`}
      tabIndex={-1}
      className="ui-tabpanel pt-5 focus:outline-none"
    >
      {children}
    </div>
  );
}
