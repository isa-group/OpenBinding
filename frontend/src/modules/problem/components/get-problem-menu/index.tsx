// Adapted from SPHERE frontend/src/modules/pricing/components/get-pricing-menu/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a problem version instead of a pricing: problems are private to their organization, so there is no permanent
// link; the menu copies the exact reference of the version (problem, number and package fingerprint), downloads its
// package as uploaded, its compiled form, or every version zipped. The button is secondary (the problem page's primary action
// is "Run this version"); the icons take the theme's accent; a download that fails says so in the menu.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FiCopy, FiCpu, FiDownload } from 'react-icons/fi';
import { HiOutlineFolderDownload } from 'react-icons/hi';

interface Props {
  /** The exact reference of the version shown, whole. */
  reference: string;
  onDownloadPackage: () => Promise<void>;
  /** Absent while the compiled form can't be read. */
  onDownloadCompiled?: () => Promise<void>;
  onDownloadAll: () => Promise<void>;
}

type Busy = 'package' | 'compiled' | 'all' | null;

export default function GetProblemMenu({
  reference,
  onDownloadPackage,
  onDownloadCompiled,
  onDownloadAll,
}: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState('');
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

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setFailure('');
    try {
      await action();
      setOpen(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message ? caught.message : 'The download failed.'
      );
    } finally {
      setBusy(null);
    }
  };

  const item = (
    key: string,
    icon: ReactNode,
    title: string,
    detail: string,
    onSelect: () => void,
    disabled = false
  ) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-left text-xs text-tp-ink hover:bg-tp-surface disabled:cursor-wait disabled:opacity-60"
    >
      {icon}
      <span>
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-[11px] text-tp-steel">{detail}</span>
      </span>
    </button>
  );
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
        <FiDownload className="h-3.5 w-3.5" aria-hidden="true" />
        Get problem
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
          aria-label="Get problem"
          className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-tp-hairline bg-tp-canvas p-1.5 shadow-elevation-3"
        >
          {item(
            'reference',
            <FiCopy className={iconClass} aria-hidden="true" />,
            copied === 'copied'
              ? 'Reference copied'
              : copied === 'failed'
                ? 'Copy failed'
                : 'Copy exact reference',
            'Problem, version and package fingerprint',
            () => void copyReference()
          )}
          {item(
            'package',
            <FiDownload className={iconClass} aria-hidden="true" />,
            busy === 'package' ? 'Preparing…' : 'Download package',
            'The .bim.zip of this version, as uploaded',
            () => void run('package', onDownloadPackage),
            busy !== null
          )}
          {item(
            'compiled',
            <FiCpu className={iconClass} aria-hidden="true" />,
            busy === 'compiled' ? 'Preparing…' : 'Download compiled form',
            onDownloadCompiled ? 'What engines read (JSON)' : 'Not available for this version',
            () => onDownloadCompiled && void run('compiled', onDownloadCompiled),
            busy !== null || !onDownloadCompiled
          )}
          {item(
            'all',
            <HiOutlineFolderDownload className={iconClass} aria-hidden="true" />,
            busy === 'all' ? 'Preparing archive…' : 'Download all versions (.zip)',
            'Every package of this problem',
            () => void run('all', onDownloadAll),
            busy !== null
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {copied === 'copied' ? 'Exact reference copied to clipboard' : ''}
          </span>
          {failure && (
            <p role="alert" className="px-3 py-2 text-[11px] text-tp-error-text">
              {failure}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
