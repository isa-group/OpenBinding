// Adapted from SPHERE frontend/src/modules/core/components/command-palette/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the commands come as props (grouped under headings), so `core` imports no domain module; the theme
// toggle and its ⌘J binding are gone (light only); combobox and listbox roles, a named dialog, focus returned on close.

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useId,
  type ComponentType,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { FiCommand, FiSearch } from 'react-icons/fi';

/** One entry of the palette. The caller builds the list, so `core` never imports a domain module. */
export interface PaletteCommand {
  id: string;
  label: string;
  description: string;
  /** A heading the entry is listed under ("Go to", "Create", an organization's name…). */
  group?: string;
  shortcut?: string[];
  icon?: ComponentType<{ className?: string }>;
  action: () => void;
}

const isMac =
  typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

function formatKey(key: string): string {
  if (key === 'mod') return isMac ? '⌘' : 'Ctrl';
  return key.toUpperCase();
}

export default function CommandPalette({
  commands,
  placeholder = 'Search commands...',
}: {
  commands: PaletteCommand[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    if (!search) return commands;
    const q = search.toLowerCase();
    return commands.filter(
      cmd =>
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q) ||
        (cmd.group ?? '').toLowerCase().includes(q)
    );
  }, [commands, search]);

  const close = useCallback(() => {
    setOpen(false);
    setSearch('');
    setSelectedIndex(0);
    if (opener.current?.isConnected) opener.current.focus();
  }, []);

  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);

  const executeCommand = useCallback((cmd: PaletteCommand) => {
    setOpen(false);
    setSearch('');
    setSelectedIndex(0);
    cmd.action();
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (open) close();
        else show();
        return;
      }

      if (!open) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (filtered.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filtered.length);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filtered.length) % filtered.length);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          executeCommand(filtered[selectedIndex]);
        }
      }
    },
    [open, filtered, selectedIndex, executeCommand, close, show]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (listRef.current && filtered.length > 0) {
      const item = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
      item?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selectedIndex, filtered]);

  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <>
      <button
        type="button"
        onClick={show}
        aria-label={`Search (${formatKey('mod')} K)`}
        aria-keyshortcuts="Control+K Meta+K"
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-tp-hairline bg-tp-surface px-2.5 py-1.5 text-xs text-tp-steel transition-colors hover:bg-tp-canvas hover:text-tp-ink"
      >
        <FiCommand className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden text-[11px] font-medium md:inline">K</span>
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <div className="fixed inset-0 z-[9999] flex items-start justify-center pt-[15vh]">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-tp-ink/40 backdrop-blur-sm"
                onClick={close}
                aria-hidden="true"
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                className="relative z-10 flex w-[90vw] max-w-150 flex-col overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas shadow-elevation-4"
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
              >
                {/* Search */}
                <div className="flex items-center gap-3 border-b border-tp-hairline px-4 py-3">
                  <FiSearch className="h-4 w-4 shrink-0 text-tp-ink" aria-hidden="true" />
                  <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-activedescendant={
                      filtered[selectedIndex] ? optionId(selectedIndex) : undefined
                    }
                    aria-label="Search commands"
                    placeholder={placeholder}
                    value={search}
                    onChange={e => {
                      setSearch(e.target.value);
                      setSelectedIndex(0);
                    }}
                    className="flex-1 bg-transparent text-sm text-tp-ink placeholder-tp-steel outline-none"
                  />
                  <kbd className="hidden shrink-0 rounded-md border border-tp-hairline bg-tp-surface px-1.5 py-0.5 text-[10px] font-medium text-tp-ink sm:inline">
                    ESC
                  </kbd>
                </div>

                {/* List */}
                <div
                  ref={listRef}
                  id={listId}
                  role="listbox"
                  className="max-h-72 overflow-y-auto px-2 py-2"
                >
                  {filtered.length === 0 ? (
                    <p className="py-8 text-center text-sm text-tp-steel">No commands found</p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {filtered.map((cmd, i) => {
                        const Icon = cmd.icon ?? FiCommand;
                        const heading =
                          cmd.group && cmd.group !== filtered[i - 1]?.group ? cmd.group : null;
                        return (
                          <div key={cmd.id} role="presentation">
                            {heading && (
                              <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-tp-steel uppercase">
                                {heading}
                              </p>
                            )}
                            <button
                              id={optionId(i)}
                              data-index={i}
                              type="button"
                              role="option"
                              aria-selected={i === selectedIndex}
                              tabIndex={-1}
                              onClick={() => executeCommand(cmd)}
                              onMouseEnter={() => setSelectedIndex(i)}
                              className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                                i === selectedIndex
                                  ? 'bg-tp-surface text-tp-ink'
                                  : 'text-tp-slate hover:bg-tp-surface hover:text-tp-ink'
                              }`}
                            >
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tp-surface text-tp-ink">
                                <Icon className="h-4 w-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-tp-ink">{cmd.label}</p>
                                <p className="text-xs text-tp-ink">{cmd.description}</p>
                              </div>
                              {cmd.shortcut && (
                                <div className="flex shrink-0 items-center gap-1">
                                  {cmd.shortcut.map((key, j) => (
                                    <kbd
                                      key={j}
                                      className="rounded-md border border-tp-hairline bg-tp-surface px-1.5 py-0.5 text-[10px] font-medium text-tp-ink"
                                    >
                                      {formatKey(key)}
                                    </kbd>
                                  ))}
                                </div>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between border-t border-tp-hairline px-4 py-2.5">
                  <div className="flex items-center gap-3 text-[11px] text-tp-ink">
                    <span className="flex items-center gap-1">
                      <kbd className="rounded border border-tp-hairline bg-tp-surface px-1 py-0.5 text-[9px]">
                        ↑↓
                      </kbd>
                      navigate
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded border border-tp-hairline bg-tp-surface px-1 py-0.5 text-[9px]">
                        ↵
                      </kbd>
                      select
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded border border-tp-hairline bg-tp-surface px-1 py-0.5 text-[9px]">
                        esc
                      </kbd>
                      close
                    </span>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
