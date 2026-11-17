// Adapted from SPHERE frontend/src/modules/pricing/components/new-version-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a problem's two ways to a new version: the problem editor (a link) and an uploaded BIM package; the icons take
// the accent token.

import { useEffect, useRef, useState } from 'react';
import { FiEdit3, FiUploadCloud } from 'react-icons/fi';
import { Link } from 'react-router-dom';

interface Props {
  /** The problem editor on the version shown. */
  editorHref: string;
  onUploadFile: () => void;
}

export default function NewVersionMenu({ editorHref, onUploadFile }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const itemClass =
    'flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface';
  const iconClass = 'mt-0.5 h-4 w-4 shrink-0 text-tp-accent';

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        New version
        <svg
          className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="New version"
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-3"
        >
          <Link
            role="menuitem"
            to={editorHref}
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <FiEdit3 className={iconClass} aria-hidden="true" />
            <span>
              <span className="block font-medium">Problem editor</span>
              <span className="mt-0.5 block text-[11px] text-tp-steel">
                Change this version and save the next one
              </span>
            </span>
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onUploadFile();
              setOpen(false);
            }}
            className={itemClass}
          >
            <FiUploadCloud className={iconClass} aria-hidden="true" />
            <span>
              <span className="block font-medium">Upload file</span>
              <span className="mt-0.5 block text-[11px] text-tp-steel">
                Add a version from a .bim.zip package
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
