// Adapted from SPHERE frontend/src/modules/pricing/components/get-pricing-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a run's link and reference, and the files it ran on (the compiled problem, the instance) and its result as JSON;
// each download says in its item whether it worked; the button and the icons take the theme's accent.

import { useEffect, useRef, useState } from 'react';
import { HiOutlineDocumentDownload } from 'react-icons/hi';
import { useCopy } from '../../../core/hooks/useCopy';

export type RunDownloadKind = 'ir' | 'instance' | 'result';

/** What a download did: under way, done, or failed with the gateway's marker. */
export type RunDownloadState = 'busy' | 'done' | `failed${string}`;

const RUN_DOWNLOADS: ReadonlyArray<{ kind: RunDownloadKind; label: string; hint: string }> = [
  {
    kind: 'ir',
    label: 'Download compiled problem',
    hint: 'The problem the engine received, as JSON',
  },
  { kind: 'instance', label: 'Download instance', hint: 'The problem version’s instance document' },
  { kind: 'result', label: 'Download result', hint: 'The result the gateway re-evaluated' },
];

interface Props {
  /** The run page's address, whole. */
  link: string;
  /** What names the run in a message or a paper: `run <id>`. */
  reference: string;
  downloads: Partial<Record<RunDownloadKind, RunDownloadState>>;
  onDownload: (kind: RunDownloadKind) => void;
}

const itemClass =
  'flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface disabled:cursor-wait disabled:opacity-60';

export default function GetRunMenu({ link, reference, downloads, onDownload }: Props) {
  const [open, setOpen] = useState(false);
  const { copy, status } = useCopy();
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

  const linkState = status('link');
  const refState = status('ref');

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
        Get run
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
          aria-label="Get run"
          className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-3"
        >
          <div className="rounded-lg bg-tp-surface p-2.5">
            <span className="mb-1.5 block text-[11px] font-semibold text-tp-ink">Run link</span>
            <div className="flex items-center gap-1.5 rounded-md border border-tp-input-border bg-tp-input-bg p-1">
              <input
                aria-label="Run link"
                readOnly
                value={link}
                onFocus={event => event.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-[10px] text-tp-steel outline-none"
              />
              <button
                type="button"
                onClick={() => void copy(link, 'link')}
                className={`h-7 shrink-0 cursor-pointer rounded-md px-2 text-[11px] font-medium text-tp-on-primary transition-colors ${
                  linkState === 'copied'
                    ? 'bg-tp-success-strong'
                    : 'bg-tp-accent hover:bg-tp-primary-deep'
                }`}
              >
                {linkState === 'copied'
                  ? 'Link copied'
                  : linkState === 'failed'
                    ? 'Copy failed'
                    : 'Copy link'}
              </button>
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => void copy(reference, 'ref')}
            className={itemClass}
          >
            <HiOutlineDocumentDownload
              className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent"
              aria-hidden="true"
            />
            <span>
              <span className="block font-medium">
                {refState === 'copied'
                  ? 'Copied'
                  : refState === 'failed'
                    ? 'Copy failed'
                    : 'Copy reference'}
              </span>
              <span className="mt-0.5 block text-[11px] text-tp-steel">{reference}</span>
            </span>
          </button>
          {RUN_DOWNLOADS.map(({ kind, label, hint }) => {
            const state = downloads[kind];
            return (
              <button
                key={kind}
                type="button"
                role="menuitem"
                disabled={state === 'busy'}
                aria-busy={state === 'busy' || undefined}
                onClick={() => onDownload(kind)}
                className={itemClass}
              >
                <svg
                  className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                  />
                </svg>
                <span>
                  <span className="block font-medium">
                    {state === 'done'
                      ? 'Downloaded'
                      : state?.startsWith('failed')
                        ? `${label} (failed${state.slice(6)})`
                        : label}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-tp-steel">{hint}</span>
                </span>
              </button>
            );
          })}
          <span className="sr-only" role="status" aria-live="polite">
            {linkState === 'copied' ? 'Run link copied to clipboard' : ''}
          </span>
        </div>
      )}
    </div>
  );
}
