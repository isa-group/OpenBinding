// Adapted from SPHERE frontend/src/modules/pricing/components/new-version-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's wording (a composition, Composition2Yaml) and one more option, "Derive from a run", which leads to the
// organization's runs; the icons take the accent token, which small marks may use in both palettes.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FiCode, FiEdit3, FiPlayCircle, FiUploadCloud } from 'react-icons/fi';
import { Link } from 'react-router-dom';

interface Props {
  onVisualEditor: () => void;
  onCodeEditor: () => void;
  onUploadFile: () => void;
  /** Where the runs a version can be derived from are listed. */
  deriveHref?: string;
}

interface Option {
  key: string;
  title: string;
  description: string;
  icon: ReactNode;
  onSelect?: () => void;
  to?: string;
}

export default function NewVersionMenu({
  onVisualEditor,
  onCodeEditor,
  onUploadFile,
  deriveHref,
}: Props) {
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

  const options: Option[] = [
    {
      key: 'visual',
      title: 'Visual editor',
      description: 'Choose a candidate per task',
      icon: <FiEdit3 className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent" aria-hidden="true" />,
      onSelect: onVisualEditor,
    },
    {
      key: 'code',
      title: 'Code editor',
      description: 'Edit the Composition2Yaml text',
      icon: <FiCode className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent" aria-hidden="true" />,
      onSelect: onCodeEditor,
    },
    {
      key: 'upload',
      title: 'Upload file',
      description: 'Add a version from a YAML file',
      icon: <FiUploadCloud className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent" aria-hidden="true" />,
      onSelect: onUploadFile,
    },
    ...(deriveHref
      ? [
          {
            key: 'derive',
            title: 'Derive from a run',
            description: 'Seal a solution of a run as a version',
            icon: (
              <FiPlayCircle className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent" aria-hidden="true" />
            ),
            to: deriveHref,
          },
        ]
      : []),
  ];

  const itemClass =
    'flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface';

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
          {options.map(option => {
            const body = (
              <>
                {option.icon}
                <span>
                  <span className="block font-medium">{option.title}</span>
                  <span className="mt-0.5 block text-[11px] text-tp-steel">
                    {option.description}
                  </span>
                </span>
              </>
            );
            return option.to ? (
              <Link
                key={option.key}
                role="menuitem"
                to={option.to}
                onClick={() => setOpen(false)}
                className={itemClass}
              >
                {body}
              </Link>
            ) : (
              <button
                key={option.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  option.onSelect?.();
                  setOpen(false);
                }}
                className={itemClass}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
