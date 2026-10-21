import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import './TabBar.css';

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
    const keys: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    move(keys[event.key]);
  };

  return (
    <div className="ui-tabbar" role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => { buttons.current[index] = node; }}
          id={`${prefix}-tab-${item.id}`}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          aria-controls={`${prefix}-panel`}
          tabIndex={item.id === value ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {item.label}
          {item.count !== undefined && <span className="ui-tabbar-count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** The panel the selected tab controls. */
export function TabPanel({ prefix, active, children }: { prefix: string; active: string; children: ReactNode }) {
  return (
    <div id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-tab-${active}`} tabIndex={-1} className="ui-tabpanel">
      {children}
    </div>
  );
}
