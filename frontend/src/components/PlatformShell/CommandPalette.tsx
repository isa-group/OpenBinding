import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { buildCommands, type PaletteContext } from './paletteCommands';
import './CommandPalette.css';

/** Dispatched on window by the header's search button; Ctrl/Cmd+K opens the palette too. */
export const OPEN_COMMAND_PALETTE_EVENT = 'openbinding:command';

export function CommandPalette({ organizations, projects, organization, project, isAdmin }: PaletteContext) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(true);
  const wasOpen = useRef(false);

  const commands = useMemo(
    () => buildCommands({ organizations, projects, organization, project, isAdmin }),
    [organizations, projects, organization, project, isAdmin],
  );
  const needle = query.trim().toLowerCase();
  const results = needle ? commands.filter((item) => `${item.label} ${item.desc} ${item.group}`.toLowerCase().includes(needle)) : commands;

  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreFocus.current = true;
    setQuery('');
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (open) close(); else show();
      }
    };
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, show);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, show);
      window.removeEventListener('keydown', keydown);
    };
  }, [open, show, close]);

  useEffect(() => {
    if (open) {
      input.current?.focus();
    } else if (wasOpen.current && restoreFocus.current && opener.current?.isConnected) {
      opener.current.focus();
    }
    wasOpen.current = open;
  }, [open]);

  const choose = () => {
    // Navigating moves the user on; do not pull focus back to the control that opened the palette.
    restoreFocus.current = false;
    close();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = dialog.current;
    if (!panel) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('input, button, a[href]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const stops: HTMLElement[] = [];
      if (input.current) stops.push(input.current);
      stops.push(...Array.from(panel.querySelectorAll<HTMLElement>('.app-palette-result')));
      const index = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'ArrowDown' ? Math.min(index + 1, stops.length - 1) : Math.max(index - 1, 0);
      stops[next]?.focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="app-palette-layer" onKeyDown={handleKeyDown}>
      <div className="app-palette-backdrop" onClick={close} aria-hidden="true" />
      <div ref={dialog} className="app-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="app-palette-search">
          <Search aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) {
                event.preventDefault();
                choose();
                navigate(results[0].href, { viewTransition: true });
              }
            }}
            aria-label="Search commands and loaded items"
            placeholder="Search commands and loaded items..."
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="app-palette-esc" onClick={close} aria-label="Close command palette">ESC</button>
        </div>
        <div className="app-palette-results">
          {results.length === 0 ? (
            <p className="app-palette-empty">No matches. Search only covers data already loaded on this device.</p>
          ) : (
            <ul>
              {results.map((item) => (
                <li key={`${item.group}:${item.href}:${item.label}`}>
                  <Link to={item.href} viewTransition className="app-palette-result" onClick={choose}>
                    <span className="app-palette-glyph" aria-hidden="true">{item.glyph}</span>
                    <span className="app-palette-text"><strong>{item.label}</strong><small>{item.desc}</small></span>
                    <span className="app-palette-group">{item.group}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="sr-only" role="status">{results.length === 0 ? 'No matches' : `${results.length} results`}</p>
        <div className="app-palette-footer">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>Local search only</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
