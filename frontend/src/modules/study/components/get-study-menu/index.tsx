// Adapted from SPHERE frontend/src/modules/pricing/components/get-pricing-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: what a study gives away instead of a pricing's YAML: the shown run as the gateway's CSV or JSON export, and the
// definition as a JSON file; the button and the icons take the theme's accent; a failed export is said in the menu.

import { useEffect, useRef, useState } from 'react';
import { HiOutlineDocumentDownload, HiOutlineTable } from 'react-icons/hi';
import type { StudyRunExportFormat } from '../../api/studiesApi';

interface Props {
  /** The run the exports are of; none before the first run. */
  runNumber: number | null;
  onExport: (format: StudyRunExportFormat) => Promise<void>;
  onDownloadDefinition: () => void;
}

const itemClass =
  'flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface disabled:cursor-wait disabled:opacity-60';

export default function GetStudyMenu({ runNumber, onExport, onDownloadDefinition }: Props) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState<StudyRunExportFormat | null>(null);
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

  const run = async (format: StudyRunExportFormat) => {
    if (exporting) return;
    setExporting(format);
    try {
      await onExport(format);
      setOpen(false);
    } finally {
      setExporting(null);
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 text-xs font-semibold text-tp-on-primary shadow-sm transition-colors hover:bg-tp-primary-deep focus:ring-2 focus:ring-tp-primary/40 focus:outline-none"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.7}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 8.25l-3.5 3.5m0 0l-3.5-3.5m3.5 3.5V3.75M5.25 14.25v3A2.25 2.25 0 007.5 19.5h9a2.25 2.25 0 002.25-2.25v-3"
          />
        </svg>
        Get study
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
          aria-label="Get study"
          className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-3"
        >
          {runNumber !== null &&
            (['csv', 'json'] as const).map(format => (
              <button
                key={format}
                type="button"
                role="menuitem"
                disabled={exporting !== null}
                onClick={() => void run(format)}
                className={itemClass}
              >
                <HiOutlineTable
                  className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent"
                  aria-hidden="true"
                />
                <span>
                  <span className="block font-medium">
                    {exporting === format ? 'Exporting…' : `Export ${format.toUpperCase()}`}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-tp-steel">
                    {format === 'csv'
                      ? `Run #${runNumber}, one row per cell`
                      : `Run #${runNumber}, its frozen definition and every cell`}
                  </span>
                </span>
              </button>
            ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onDownloadDefinition();
              setOpen(false);
            }}
            className={itemClass}
          >
            <HiOutlineDocumentDownload
              className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent"
              aria-hidden="true"
            />
            <span>
              <span className="block font-medium">Download the definition</span>
              <span className="mt-0.5 block text-[11px] text-tp-steel">
                The problem versions, engines, settings and seeds as JSON
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
