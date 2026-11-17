// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a BIM package instead of a pricing. The destinations are a new problem (an organization where the account is
// MEMBER, and a name, the Instance's `metadata.name` by default, whose slug is the problem's address) and a new version of a
// problem the account may write (an organization where it is MEMBER, then one of its problems, found by name; the one the
// editor was opened on first). There is no visibility: problems belong to their organization. The package is saved as the
// gateway checked it (`producer=openbinding-problem-editor`); the same package again is not a new version, which the editor
// says; a refusal is said in the dialog. Escape closes it.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { FiArrowUpRight, FiCheck, FiFilePlus, FiSave, FiSearch, FiX } from 'react-icons/fi';
import { problemsApi, type Problem } from '../../../../api/problems';
import { slugFromName, SLUG_PATTERN } from '../../../core/utils/slug';
import OrganizationSelector from '../../../organization/components/organization-selector';
import type { Organization } from '../../../organization/api/organizationsApi';
import type { SavedPackage } from '../../contexts/problemEditorContext';
import type { SaveTarget } from '../../hooks/useProblemEditor';
import { useProblemEditorValue } from '../../hooks/useProblemEditorValue';
import { parseJson } from '../../utils/documents';

type Destination = 'new' | 'version';

/** How many problems the search reads: the gateway's ceiling for one page. */
const PICKER_LIMIT = 200;
const MAX_RESULTS = 6;
const INPUT =
  'h-10 w-full rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 text-sm text-tp-ink outline-none transition-colors placeholder:text-tp-muted focus:border-tp-accent focus:ring-2 focus:ring-tp-accent/10';

export default function SaveModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (saved: SavedPackage) => void;
}) {
  const titleId = useId();
  const { editor, org: openedOrg, problem: openedProblem } = useProblemEditorValue();
  const packageName = useMemo(() => {
    const root = parseJson(editor.files['instance.json']);
    return typeof root?.metadata?.name === 'string' ? root.metadata.name : '';
  }, [editor.files]);

  const [destination, setDestination] = useState<Destination>(
    openedOrg && openedProblem ? 'version' : 'new'
  );
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [name, setName] = useState(packageName);
  const [problems, setProblems] = useState<{
    org: string;
    list: Problem[];
    issue: string;
  } | null>(null);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<Problem | null>(null);
  const [issue, setIssue] = useState<ReactNode>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const org = organization?.slug ?? null;

  useEffect(() => {
    closeRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // The problems of the chosen organization; the one the editor was opened on is chosen at once.
  useEffect(() => {
    if (destination !== 'version' || !org) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => problemsApi.list(org, { limit: PICKER_LIMIT }))
      .then(
        page => {
          if (!active) return;
          setProblems({ org, list: page.problems, issue: '' });
          if (org === openedOrg && openedProblem) {
            const opened = page.problems.find(item => item.slug === openedProblem);
            if (opened) setTarget(current => current ?? opened);
          }
        },
        () => {
          if (active)
            setProblems({
              org,
              list: [],
              issue: 'The organization’s problems couldn’t be listed.',
            });
        }
      );
    return () => {
      active = false;
    };
  }, [destination, org, openedOrg, openedProblem]);

  const list = problems && problems.org === org ? problems.list : [];
  const listIssue = problems && problems.org === org ? problems.issue : '';
  const query = search.trim().toLowerCase();
  const matches = list.filter(
    item => !query || item.name.toLowerCase().includes(query) || item.slug.includes(query)
  );
  const shown = matches.slice(0, MAX_RESULTS);
  const hidden = Math.max(0, matches.length - shown.length);
  const slug = slugFromName(name);
  const shownTarget = target && list.some(item => item.id === target.id) ? target : null;

  const canSave =
    !editor.saving &&
    editor.savable &&
    Boolean(org) &&
    (destination === 'new' ? Boolean(name.trim()) : Boolean(shownTarget));

  const save = async () => {
    if (!org) return;
    setIssue(null);
    const request: SaveTarget =
      destination === 'new'
        ? {
            kind: 'new',
            org,
            name: name.trim() || undefined,
            slug: SLUG_PATTERN.test(slug) ? slug : undefined,
          }
        : { kind: 'version', org, problem: shownTarget!.slug };
    const outcome = await editor.save(request);
    if (outcome.kind === 'refused') {
      setIssue(outcome.message);
      return;
    }
    onSaved({ org, outcome });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-3 pt-[8dvh] backdrop-blur-sm sm:p-4 sm:pt-[10dvh]"
      role="presentation"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(92dvh-0.75rem)] w-full max-w-[42rem] flex-col overflow-hidden rounded-2xl border border-tp-hairline bg-tp-canvas shadow-elevation-4 sm:max-h-[calc(90dvh-1rem)]"
        onClick={event => event.stopPropagation()}
      >
        <header className="relative shrink-0 overflow-hidden border-b border-tp-hairline bg-tp-surface px-5 py-3.5 sm:px-6">
          <div className="absolute -top-12 -right-8 h-32 w-32 rounded-full bg-tp-primary/10 blur-2xl" />
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-tp-accent text-tp-on-primary shadow-sm">
                <FiSave className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2
                  id={titleId}
                  className="font-display text-lg leading-tight font-semibold text-tp-ink"
                >
                  Save the package
                </h2>
                {editor.savable ? (
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-tp-steel">
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white">
                      <FiCheck className="h-2.5 w-2.5" aria-hidden="true" />
                    </span>
                    <span className="truncate">
                      <span className="font-medium text-tp-ink">{packageName || 'Untitled'}</span> ·
                      valid, ready to save
                    </span>
                  </p>
                ) : null}
              </div>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close the save dialog"
              className="cursor-pointer rounded-lg p-2 text-tp-steel transition-colors hover:bg-tp-canvas hover:text-tp-ink"
            >
              <FiX className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">
          <div className="space-y-4">
            {!editor.savable ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                <p className="font-medium">The package saves once it passes its check.</p>
                <p className="mt-1 text-xs leading-5 text-red-700">
                  The problems panel lists what the gateway found.
                </p>
              </div>
            ) : null}
            <fieldset>
              <legend className="sr-only">Where should this package go?</legend>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-tp-surface p-1">
                <DestinationButton
                  active={destination === 'new'}
                  icon={<FiFilePlus className="h-4 w-4" aria-hidden="true" />}
                  title="New problem"
                  onClick={() => {
                    setDestination('new');
                    setIssue(null);
                  }}
                />
                <DestinationButton
                  active={destination === 'version'}
                  icon={<FiSave className="h-4 w-4" aria-hidden="true" />}
                  title="New version"
                  onClick={() => {
                    setDestination('version');
                    setIssue(null);
                  }}
                />
              </div>
              <p className="mt-1.5 px-1 text-xs text-tp-steel">
                {destination === 'new'
                  ? 'Create a problem in one of your organizations, with this package as its first version.'
                  : 'Add this package as a new version of a problem you may write. The same package again is not a new version.'}
              </p>
            </fieldset>
            <OrganizationSelector
              value={organization}
              onChange={next => {
                setOrganization(next);
                setTarget(null);
              }}
              initialSlug={openedOrg}
              minRole="MEMBER"
            />
            {destination === 'new' ? (
              <label className="block">
                <span className="mb-1 block text-sm text-tp-slate">Name of the new problem</span>
                <input
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder="e.g. Checkout flow"
                  className={INPUT}
                />
                {name.trim() && (
                  <span className="mt-1 block text-xs text-tp-steel">Its address: {slug}</span>
                )}
              </label>
            ) : org ? (
              <section aria-labelledby={`${titleId}-target`} className="space-y-3">
                <h3 id={`${titleId}-target`} className="text-sm font-medium text-tp-slate">
                  Choose a problem
                </h3>
                {shownTarget ? (
                  <div className="flex items-center gap-3 rounded-lg border border-tp-primary bg-tp-primary/5 px-3 py-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tp-accent text-tp-on-primary">
                      <FiCheck className="h-3 w-3" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-tp-ink">
                        {shownTarget.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-tp-steel">
                        {organization?.name ?? org}
                        {shownTarget.latest_revision
                          ? ` · latest v${shownTarget.latest_revision.revision}`
                          : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setTarget(null)}
                      className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-medium text-tp-accent transition-colors hover:bg-tp-primary/10"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <FiSearch
                        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-tp-steel"
                        aria-hidden="true"
                      />
                      <input
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        aria-label="Search the organization’s problems by name"
                        placeholder="Type to search the problems…"
                        className={`${INPUT} pl-9`}
                      />
                    </div>
                    <ul aria-label="Problems you may write" className="space-y-2">
                      {listIssue ? (
                        <li className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                          {listIssue}
                        </li>
                      ) : !problems || problems.org !== org ? (
                        <EmptyState>Loading problems…</EmptyState>
                      ) : shown.length === 0 ? (
                        <EmptyState>
                          {query
                            ? `No problem matches “${search.trim()}”.`
                            : 'The organization has no problem to add a version to yet.'}
                        </EmptyState>
                      ) : (
                        shown.map(item => (
                          <li key={item.id}>
                            <button
                              type="button"
                              onClick={() => setTarget(item)}
                              className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2 text-left transition-colors hover:border-tp-primary/40 hover:bg-tp-surface"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-semibold text-tp-ink">
                                  {item.name}
                                </span>
                                <span className="mt-0.5 block truncate font-mono text-xs text-tp-steel">
                                  {item.slug}
                                </span>
                              </span>
                              {org === openedOrg && item.slug === openedProblem ? (
                                <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
                                  Opened here
                                </span>
                              ) : null}
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                    {hidden > 0 ? (
                      <p className="text-center text-xs text-tp-steel">
                        {hidden} more {hidden === 1 ? 'problem' : 'problems'} — keep typing to
                        narrow the list.
                      </p>
                    ) : null}
                  </>
                )}
              </section>
            ) : null}
            {issue ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3" role="alert">
                <p className="text-xs font-medium text-red-800">The package wasn’t saved</p>
                <p className="mt-1 text-xs leading-5 text-red-800">{issue}</p>
              </div>
            ) : null}
          </div>
        </main>
        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-tp-hairline bg-tp-surface px-5 py-3 sm:px-6">
          <p className="hidden text-xs text-tp-steel sm:block">
            A saved version runs from its problem page.
          </p>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg px-4 py-2 text-sm font-medium text-tp-slate transition-colors hover:bg-tp-canvas hover:text-tp-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-accent px-4 py-2 text-sm font-semibold text-tp-on-primary transition-all hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {editor.saving
                ? 'Saving…'
                : destination === 'version'
                  ? shownTarget
                    ? `Save as a new version of ${shownTarget.name}`
                    : 'Save as a new version'
                  : 'Save as a new problem'}
              {!editor.saving ? <FiArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function DestinationButton({
  active,
  icon,
  title,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${active ? 'border-tp-primary/30 bg-tp-canvas text-tp-ink shadow-sm' : 'border-transparent text-tp-steel hover:text-tp-ink'}`}
    >
      <span className={active ? 'text-tp-accent' : ''}>{icon}</span>
      {title}
    </button>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <li className="rounded-xl border border-dashed border-tp-hairline-strong px-4 py-6 text-center text-sm text-tp-steel">
      {children}
    </li>
  );
}
