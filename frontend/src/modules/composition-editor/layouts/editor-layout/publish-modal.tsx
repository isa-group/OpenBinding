// Adapted from SPHERE frontend/src/modules/pricing-editor/layouts/editor-layout/publish-pricing-modal.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition instead of a pricing. The destinations are a new composition (an organization where the account is
// MEMBER, a name, Public or Private, Public needing ADMIN) and a new version of a composition the account may write, found
// by a search over its compositions (`GET /v1/users/me/compositions?q=`), the one the editor was opened on first. The version
// label is the document's `version`, checked against the labels the composition already has and written back into the
// document when it is changed here; there is no release date. The document is read by the gateway (its lint is in the
// problems panel), and before sealing into an existing composition the dialog shows what the seal would hold (`POST
// …/versions/check`): its values and whether they will be verified or declared. Publishing seals the document and lands on
// the new version in the Versions tab; a seal that finds the same bytes, a taken label or a refused document is said in
// the dialog; the canonical form the check answers can replace the text before it is sealed. Escape closes it.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  FiArrowUpRight,
  FiCheck,
  FiFilePlus,
  FiGlobe,
  FiLock,
  FiSearch,
  FiUploadCloud,
  FiX,
} from 'react-icons/fi';
import { Link, useNavigate } from 'react-router-dom';
import { readApiError } from '../../../core/api/errors';
import type { CheckResult, CompositionView } from '../../../core/api/types';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { formatValue } from '../../../core/utils/composition/values';
import { slugFromName } from '../../../core/utils/slug';
import { compositionsApi, useCompositionsApi } from '../../../composition/api/compositionsApi';
import { roleAtLeast } from '../../../composition/hooks/useCompositionRole';
import OrganizationSelector from '../../../organization/components/organization-selector';
import type { Organization } from '../../../organization/api/organizationsApi';
import { useOrganization } from '../../../organization/hooks/useOrganization';
import { compositionPath } from '../../../../routes/paths/compositions';
import { useEditorValue } from '../../hooks/useEditorValue';
import { scalarAt } from '../../utils/yamlText';
import FocusTrapLayer from '../../../core/components/focus-trap-layer';

interface PublishModalProps {
  onClose: () => void;
}

type Visibility = 'public' | 'private';
type Destination = 'new' | 'version';

const MAX_RESULTS = 5;
const INPUT =
  'h-10 w-full rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 text-sm text-tp-ink outline-none transition-colors placeholder:text-tp-muted focus:border-tp-accent focus:ring-2 focus:ring-tp-accent/10';

export default function PublishModal({ onClose }: PublishModalProps) {
  const navigate = useNavigate();
  const titleId = useId();
  const { editor, source, organization: preferredOrg } = useEditorValue();
  const { getMyCompositions } = useCompositionsApi();
  const { organizations } = useOrganization();
  const yaml = editor.text;
  const documentName = useMemo(() => scalarAt(yaml, ['composition'])?.value.trim() ?? '', [yaml]);
  const documentKind = useMemo(() => scalarAt(yaml, ['kind'])?.value.trim() ?? '', [yaml]);

  const [destination, setDestination] = useState<Destination>(source ? 'version' : 'new');
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  const [name, setName] = useState(documentName);
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [target, setTarget] = useState<CompositionView | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CompositionView[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [errors, setErrors] = useState<ReactNode[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  const writable = useMemo(
    () =>
      new Set(
        organizations.filter(org => roleAtLeast(org.effective_role, 'MEMBER')).map(org => org.slug)
      ),
    [organizations]
  );
  const canPublishPublicly = roleAtLeast(selectedOrg?.effective_role, 'ADMIN');

  // The compositions the account may add a version to, the one the editor was opened on first.
  useEffect(() => {
    if (destination !== 'version' || target) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      setSearchError('');
      getMyCompositions({ q: search.trim(), limit: '50' }, controller.signal).then(
        page => {
          const mine = page.compositions.filter(item => writable.has(item.organization.slug));
          const first = source
            ? [
                ...mine.filter(
                  item => item.slug === source.slug && item.organization.slug === source.org
                ),
                ...mine.filter(
                  item => !(item.slug === source.slug && item.organization.slug === source.org)
                ),
              ]
            : mine;
          setResults(first);
          setTotal(first.length);
          setSearching(false);
        },
        (caught: unknown) => {
          if (controller.signal.aborted) return;
          setSearchError(readApiError(caught).message || 'Your compositions couldn’t be loaded.');
          setSearching(false);
        }
      );
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [destination, target, search, source, writable, getMyCompositions]);

  // The labels the chosen composition already has, and what sealing the document into it would hold.
  useEffect(() => {
    if (!target) return undefined;
    let active = true;
    const org = target.organization.slug;
    compositionsApi.allVersions(org, target.slug).then(
      versions => {
        if (active) setLabels(versions.map(version => version.label));
      },
      () => undefined
    );
    compositionsApi.check(org, target.slug, yaml).then(
      result => {
        if (active) setCheck(result);
      },
      () => {
        if (active) setCheck(null);
      }
    );
    return () => {
      active = false;
    };
  }, [target, yaml]);

  const label = editor.label;
  const labelError =
    destination === 'version' && target && labels.includes(label)
      ? `${target.name} already has a version ${label}. Give this one another label.`
      : destination === 'version' && target && !label
        ? 'Give this version a label.'
        : '';
  const results5 = results.slice(0, MAX_RESULTS);
  const hiddenResults = Math.max(0, total - results5.length);
  const errorsInDocument = editor.errors;

  const canPublish =
    !isPublishing &&
    errorsInDocument === 0 &&
    (destination === 'new' ? Boolean(selectedOrg && name.trim()) : Boolean(target && !labelError));

  const landed = (org: string, slug: string, version: string, toast: string) => {
    onClose();
    void navigate(compositionPath(org, slug, 'versions', { version }), { state: { toast } });
  };

  const handlePublish = async () => {
    setErrors([]);
    setIsPublishing(true);
    let org = '';
    let slug = '';
    try {
      if (destination === 'new') {
        if (!selectedOrg) return;
        org = selectedOrg.slug;
        slug = slugFromName(name);
        await compositionsApi.create(org, {
          slug,
          name: name.trim(),
          kind: (documentKind || 'application') as CompositionView['kind'],
          description: '',
        });
        if (visibility === 'public' && canPublishPublicly) {
          const { etag } = await compositionsApi.get(org, slug);
          await compositionsApi.update(org, slug, { visibility: 'public' }, etag);
        }
      } else {
        if (!target) return;
        org = target.organization.slug;
        slug = target.slug;
      }
      const outcome = await editor.seal({ org, slug });
      if (outcome.kind === 'created') {
        landed(
          org,
          slug,
          outcome.result.version.label,
          destination === 'new'
            ? `Composition “${name.trim()}” published with its version ${outcome.result.version.label}.`
            : `Version ${outcome.result.version.label} sealed.`
        );
        return;
      }
      if (outcome.kind === 'exists') {
        setErrors([
          <>
            This exact version already exists:{' '}
            <Link
              to={compositionPath(org, slug, 'versions', { version: outcome.result.version.label })}
              onClick={onClose}
              className="font-medium underline"
            >
              {outcome.result.version.label}
            </Link>
            .
          </>,
        ]);
      } else if (outcome.kind === 'labelTaken') {
        setErrors([
          `${outcome.message || 'This label is taken by another version.'} Choose another label.`,
        ]);
      } else if (outcome.kind === 'invalid') {
        setErrors(['The gateway refused the document. Its problems are listed under the code.']);
      } else {
        setErrors([
          `The version couldn’t be sealed${outcome.status ? ` (${outcome.status})` : ''}: ${outcome.message || 'try again in a moment.'}`,
        ]);
      }
    } catch (caught) {
      const refusal = readApiError(caught);
      const orgName =
        destination === 'new' ? (selectedOrg?.name ?? org) : (target?.organization.name ?? org);
      setErrors([
        refusal.code === 'slug_conflict'
          ? `${slug} is in use in ${orgName}. Choose another name.`
          : refusal.status === 403
            ? `Publishing needs MEMBER in ${orgName}.`
            : refusal.message || 'The composition couldn’t be published. Try again in a moment.',
      ]);
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <FocusTrapLayer onEscape={onClose}>
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
                  <FiUploadCloud className="h-[18px] w-[18px]" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2
                    id={titleId}
                    className="font-display text-lg leading-tight font-semibold text-tp-ink"
                  >
                    Publish to OpenBinding
                  </h2>
                  {errorsInDocument === 0 ? (
                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-tp-steel">
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white">
                        <FiCheck className="h-2.5 w-2.5" aria-hidden="true" />
                      </span>
                      <span className="truncate">
                        <span className="font-medium text-tp-ink">
                          {documentName || 'Untitled'}
                        </span>
                        {label ? ` · ${label}` : ''} · ready to publish
                      </span>
                    </p>
                  ) : null}
                </div>
              </div>
              <button
                ref={closeRef}
                data-autofocus
                type="button"
                onClick={onClose}
                aria-label="Close publish dialog"
                className="cursor-pointer rounded-lg p-2 text-tp-steel transition-colors hover:bg-tp-canvas hover:text-tp-ink"
              >
                <FiX className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">
            <div className="space-y-4">
              {errorsInDocument > 0 ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <p className="font-medium">The YAML needs attention before publishing.</p>
                  <p className="mt-1 text-xs leading-5 text-red-700">
                    {errorsInDocument === 1
                      ? 'The problems panel lists 1 error.'
                      : `The problems panel lists ${errorsInDocument} errors.`}
                  </p>
                </div>
              ) : null}
              <fieldset>
                <legend className="sr-only">Where should this draft go?</legend>
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-tp-surface p-1">
                  <DestinationButton
                    active={destination === 'new'}
                    icon={<FiFilePlus className="h-4 w-4" aria-hidden="true" />}
                    title="New composition"
                    onClick={() => {
                      setDestination('new');
                      setErrors([]);
                    }}
                  />
                  <DestinationButton
                    active={destination === 'version'}
                    icon={<FiUploadCloud className="h-4 w-4" aria-hidden="true" />}
                    title="New version"
                    onClick={() => {
                      setDestination('version');
                      setErrors([]);
                    }}
                  />
                </div>
                <p className="mt-1.5 px-1 text-xs text-tp-steel">
                  {destination === 'new'
                    ? 'Create a new composition in one of your organizations.'
                    : 'Add this draft as a new version of a composition you may write.'}
                </p>
              </fieldset>
              {destination === 'new' ? (
                <>
                  <OrganizationSelector
                    value={selectedOrg}
                    onChange={setSelectedOrg}
                    initialSlug={preferredOrg ?? source?.org ?? null}
                    minRole="MEMBER"
                  />
                  <label className="block">
                    <span className="mb-1 block text-sm text-tp-slate">Composition name</span>
                    <input
                      value={name}
                      onChange={event => setName(event.target.value)}
                      placeholder="e.g. Order desk"
                      className={INPUT}
                    />
                    {name.trim() && (
                      <span className="mt-1 block text-xs text-tp-steel">
                        Its address: {slugFromName(name)}
                      </span>
                    )}
                  </label>
                  <VisibilityPicker
                    value={visibility}
                    onChange={setVisibility}
                    publicAllowed={canPublishPublicly}
                  />
                </>
              ) : (
                <section aria-labelledby={`${titleId}-target`} className="space-y-4">
                  <div>
                    <h3 id={`${titleId}-target`} className="text-sm font-medium text-tp-slate">
                      Choose a composition
                    </h3>
                    <p className="mt-0.5 text-xs text-tp-steel">
                      The version is sealed into the composition you choose, in its organization.
                    </p>
                  </div>
                  {target ? (
                    <SelectedComposition
                      composition={target}
                      onChange={() => {
                        setTarget(null);
                        setCheck(null);
                        setLabels([]);
                      }}
                    />
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
                          onKeyDown={event => {
                            if (event.key === 'Enter' && results5[0]) {
                              event.preventDefault();
                              setTarget(results5[0]);
                            }
                          }}
                          aria-label="Search your compositions by name"
                          placeholder="Type to search your compositions…"
                          className={`${INPUT} pl-9`}
                        />
                      </div>
                      <ul aria-label="Compositions you may write" className="space-y-2">
                        {searching && results5.length === 0 ? (
                          <EmptyState>Loading compositions…</EmptyState>
                        ) : searchError ? (
                          <li className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                            {searchError}
                          </li>
                        ) : results5.length === 0 ? (
                          <EmptyState>
                            {search.trim()
                              ? `None of your compositions match “${search.trim()}”.`
                              : 'You have no composition to add a version to yet.'}
                          </EmptyState>
                        ) : (
                          results5.map(composition => (
                            <li key={composition.id}>
                              <CompositionTarget
                                composition={composition}
                                highlight={
                                  !!source &&
                                  composition.slug === source.slug &&
                                  composition.organization.slug === source.org
                                }
                                onSelect={setTarget}
                              />
                            </li>
                          ))
                        )}
                      </ul>
                      {hiddenResults > 0 ? (
                        <p className="text-center text-xs text-tp-steel">
                          {hiddenResults} more{' '}
                          {hiddenResults === 1 ? 'composition' : 'compositions'} — keep typing to
                          narrow the list.
                        </p>
                      ) : null}
                    </>
                  )}
                  {target ? (
                    <>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-tp-slate">
                          Version label
                        </span>
                        <input
                          key={label}
                          defaultValue={label}
                          spellCheck={false}
                          aria-invalid={Boolean(labelError)}
                          onBlur={event => editor.setLabel(event.target.value.trim())}
                          onKeyDown={event => {
                            if (event.key === 'Enter')
                              editor.setLabel((event.target as HTMLInputElement).value.trim());
                          }}
                          className={INPUT}
                        />
                        {labelError ? (
                          <span className="mt-1 block text-xs text-red-700">{labelError}</span>
                        ) : (
                          <span className="mt-1 block text-xs text-tp-steel">
                            The document’s <code className="font-mono">version</code>; changing it
                            here changes the document.
                          </span>
                        )}
                      </label>
                      {check?.valid ? (
                        <ValuesOnSeal
                          check={check}
                          onUseCanonical={
                            check.content !== null && check.content !== yaml
                              ? () => {
                                  if (check.content) editor.setText(check.content);
                                }
                              : null
                          }
                        />
                      ) : null}
                    </>
                  ) : null}
                </section>
              )}
              {errors.length > 0 ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3" role="alert">
                  {errors.map((error, index) => (
                    <p key={index} className="text-xs leading-5 text-red-800">
                      {error}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </main>
          <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-tp-hairline bg-tp-surface px-5 py-3 sm:px-6">
            <p className="hidden text-xs text-tp-steel sm:block">
              {destination === 'version'
                ? target
                  ? `Adding a version to ${target.name}.`
                  : 'Select a composition to add a version.'
                : 'A new composition will be created in the selected organization.'}
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
                onClick={() => void handlePublish()}
                disabled={!canPublish}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-tp-accent px-4 py-2 text-sm font-semibold text-tp-on-primary transition-all hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isPublishing
                  ? 'Publishing…'
                  : destination === 'version'
                    ? 'Publish version'
                    : 'Publish'}
                {!isPublishing ? <FiArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
              </button>
            </div>
          </footer>
        </motion.div>
      </motion.div>
    </FocusTrapLayer>
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

function CompositionTarget({
  composition,
  highlight,
  onSelect,
}: {
  composition: CompositionView;
  highlight: boolean;
  onSelect: (composition: CompositionView) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(composition)}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2 text-left transition-colors hover:border-tp-primary/40 hover:bg-tp-surface"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-tp-ink">{composition.name}</span>
        <span className="mt-0.5 block truncate text-xs text-tp-steel">
          {composition.organization.name}
          {composition.latest_version
            ? ` · ${composition.latest_version.label}`
            : ' · no version yet'}
        </span>
      </span>
      {highlight ? (
        <span className="rounded-full bg-tp-primary/10 px-2 py-0.5 text-[10px] font-medium text-tp-accent">
          Opened here
        </span>
      ) : null}
      <span
        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${composition.visibility === 'public' ? 'bg-emerald-50 text-emerald-800' : 'bg-tp-surface text-tp-steel'}`}
      >
        {composition.visibility === 'public' ? 'Public' : 'Private'}
      </span>
    </button>
  );
}

function SelectedComposition({
  composition,
  onChange,
}: {
  composition: CompositionView;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-tp-primary bg-tp-primary/5 px-3 py-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tp-accent text-tp-on-primary">
        <FiCheck className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-tp-ink">{composition.name}</span>
        <span className="mt-0.5 block truncate text-xs text-tp-steel">
          {composition.organization.name}
          {composition.latest_version
            ? ` · latest ${composition.latest_version.label}`
            : ' · no version yet'}
        </span>
      </span>
      <button
        type="button"
        onClick={onChange}
        className="cursor-pointer rounded-lg px-2.5 py-1 text-xs font-medium text-tp-accent transition-colors hover:bg-tp-primary/10"
      >
        Change
      </button>
    </div>
  );
}

function VisibilityPicker({
  value,
  onChange,
  publicAllowed,
}: {
  value: Visibility;
  onChange: (visibility: Visibility) => void;
  publicAllowed: boolean;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm text-tp-slate">Visibility</legend>
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-tp-surface p-1">
        {[
          {
            value: 'public' as const,
            label: 'Public',
            description: 'Visible in Explore',
            icon: FiGlobe,
          },
          {
            value: 'private' as const,
            label: 'Private',
            description: 'Organization only',
            icon: FiLock,
          },
        ].map(option => {
          const Icon = option.icon;
          const selected = value === option.value;
          const disabled = option.value === 'public' && !publicAllowed;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'border-tp-primary/30 bg-tp-canvas text-tp-ink shadow-sm' : 'border-transparent text-tp-steel hover:text-tp-ink'}`}
            >
              <Icon
                className={`h-4 w-4 shrink-0 ${selected ? 'text-tp-accent' : ''}`}
                aria-hidden="true"
              />
              <span>
                <span className="block text-xs font-medium">{option.label}</span>
                <span className="block text-[10px] text-tp-steel">{option.description}</span>
              </span>
            </button>
          );
        })}
      </div>
      {!publicAllowed ? (
        <p className="mt-1.5 text-xs text-tp-steel">
          Publishing publicly needs ADMIN in the organization.
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * What the seal's assessment says the version would hold: its values and how far they can be trusted, and the canonical form
 * the gateway would write, offered when the text differs from it.
 */
function ValuesOnSeal({
  check,
  onUseCanonical,
}: {
  check: CheckResult;
  onUseCanonical: (() => void) | null;
}) {
  const values = Object.entries(check.values ?? {});
  return (
    <section
      aria-label="Values on seal"
      className="rounded-xl border border-tp-hairline bg-tp-surface px-4 py-3"
    >
      <p className="flex flex-wrap items-center gap-2 text-xs text-tp-slate">
        {check.values_status === 'verified'
          ? 'These values will be verified:'
          : 'These values will be declared:'}
        <ValueBadge status={check.values_status === 'verified' ? 'verified' : 'declared'} />
      </p>
      {values.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {values.map(([valueName, value]) => (
            <div key={valueName} className="min-w-0">
              <dt className="truncate text-tp-steel">{valueName}</dt>
              <dd className="font-mono text-tp-ink">{formatValue(value.value, value.unit)}</dd>
            </div>
          ))}
        </dl>
      )}
      {onUseCanonical && (
        <button
          type="button"
          onClick={onUseCanonical}
          className="mt-2 cursor-pointer rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 py-1.5 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
        >
          Use the canonical form
        </button>
      )}
    </section>
  );
}
