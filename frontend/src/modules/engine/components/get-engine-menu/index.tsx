// Adapted from SPHERE frontend/src/modules/pricing/components/get-pricing-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: an engine revision's exact reference (namespace/name@version#digest) in the copy box instead of a pricing's link,
// and its manifest as the one download; the button and the icons take the theme's accent instead of Tailwind's orange and two
// hex colours, so both palettes draw it; the menu closes on Escape and the copy is announced.

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { MdCheck, MdContentCopy, MdDownload } from 'react-icons/md';

interface Props {
  /** The exact reference a run or a study names the revision by. */
  reference: string;
  onDownloadManifest: () => void;
}

export default function GetEngineMenu({ reference, onDownloadManifest }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
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

  const copyReference = async () => {
    try {
      await navigator.clipboard.writeText(reference);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied(null), 1800);
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
        <MdDownload className="h-3.5 w-3.5" aria-hidden="true" />
        Get engine
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
          aria-label="Get engine"
          className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-3"
        >
          <div className="rounded-lg bg-tp-surface p-2.5">
            <span className="mb-1.5 block text-[11px] font-semibold text-tp-ink">
              Exact reference
            </span>
            <div className="flex items-center gap-1.5 rounded-md border border-tp-input-border bg-tp-input-bg p-1">
              <input
                aria-label="Exact engine reference"
                readOnly
                value={reference}
                onFocus={event => event.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent px-1.5 py-1 font-mono text-[10px] text-tp-steel outline-none"
              />
              <motion.button
                type="button"
                role="menuitem"
                aria-label={copied === 'copied' ? 'Reference copied' : 'Copy exact reference'}
                onClick={() => void copyReference()}
                whileTap={{ scale: 0.86 }}
                className={`flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-tp-on-primary transition-colors ${
                  copied === 'copied'
                    ? 'bg-tp-success-strong'
                    : 'bg-tp-accent hover:bg-tp-primary-deep'
                }`}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={copied ?? 'copy'}
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {copied === 'copied' ? (
                      <MdCheck className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <MdContentCopy className="h-4 w-4" aria-hidden="true" />
                    )}
                  </motion.span>
                </AnimatePresence>
              </motion.button>
            </div>
            <span className="sr-only" role="status" aria-live="polite">
              {copied === 'copied'
                ? 'Reference copied to clipboard'
                : copied === 'failed'
                  ? 'The reference could not be copied'
                  : ''}
            </span>
          </div>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onDownloadManifest();
              setOpen(false);
            }}
            className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface"
          >
            <MdDownload className="mt-0.5 h-4 w-4 shrink-0 text-tp-accent" aria-hidden="true" />
            <span>
              <span className="block font-medium">Download manifest</span>
              <span className="mt-0.5 block text-[11px] text-tp-steel">
                The engine document, for tools that need the file
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
