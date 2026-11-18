// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a composition instead of a pricing, one page for every reader. The shell, the header (breadcrumb, version select
// or chip with "· Updated X ago", the dotted "Forked from" line), Follow, Fork, New version, the Get menu, the stat tiles and
// the tabs are SPHERE's; the tab is in the address (`/compositions/:org/:composition/:tab?`) and the version in `?version=`.
// Who may do what comes from OpenBinding's roles (MEMBER writes, ADMIN changes who reads it and deletes it), not SPHERE's
// entity permissions. The Overview draws OpenBinding's composition renderer (showcase for a visitor; catalog, architecture
// and workflow for a member) beside SPHERE's "Show details" sidebar. A missing or unreadable composition is the in-place 404
// (no PrivateAccessFallback); a visitor who forks signs in first and comes back with the Fork modal open once. pricing4ts,
// HARVEY, the versions-visibility modal and per-version deletion are not brought.

import { formatDistanceToNow, parseISO } from 'date-fns';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { config } from '../../../../config';
import { useResource } from '../../../core/hooks/useResource';
import { classifyAuthError, marker, readApiError } from '../../../core/api/errors';
import type { CompositionVersionView, ProblemFacts } from '../../../core/api/types';
import ResourceCardShell, {
  type OverflowAction,
  type ShellTab,
} from '../../../core/components/resource-card-shell';
import PricingCardSkeleton from '../../../core/components/skeletons/pricing-card-skeleton';
import { CompositionRenderer } from '../../../core/components/composition-renderer/CompositionRenderer';
import { loadUpstream, type RendererUpstream } from '../../../core/utils/composition/upstream';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import { useRecentItems } from '../../../core/hooks/useRecentItems';
import NotFoundPage from '../../../core/pages/page-not-found';
import { factsSource } from '../../../core/utils/composition/factsSource';
import { pickVersion } from '../../../core/utils/composition/versionRef';
import {
  compositionViewModel,
  type CompositionViewModel,
} from '../../../core/utils/composition/viewModel';
import customAlert from '../../../core/utils/custom-alert';
import { problemFactsApi } from '../../../core/utils/problem/facts';
import { useAuth } from '../../../auth/hooks/useAuth';
import { orgPath } from '../../../organization/types/paths';
import {
  compositionPath,
  editorPath,
  compositionsPath,
  isCompositionTabSegment,
  permalinkPath,
  type CompositionTabSegment,
} from '../../../../routes/paths/compositions';
import { problemEditorPath, problemPath } from '../../../../routes/paths/problems';
import { runPath, runsPath } from '../../../../routes/paths/runs';
import { compositionsApi, useCompositionsApi } from '../../api/compositionsApi';
import CompositionImportModal from '../../components/composition-import-modal';
import CompositionSettingsTab from '../../components/composition-settings-tab';
import CompositionTree, { type CompositionAnalytics } from '../../components/composition-tree';
import FollowButton from '../../components/follow-button';
import ForkCompositionModal from '../../components/fork-composition-modal';
import GetCompositionMenu from '../../components/get-composition-menu';
import NewVersionMenu from '../../components/new-version-menu';
import PricingLinkModal from '../../components/pricing-link-modal';
import { compositionStats } from '../../components/stats';
import YamlSourcePanel from '../../components/yaml-source-panel';
import CompositionVersionGraph from '../../components/version-graph';
import CompositionVersionsTab from '../../components/versions-tab';
import CompositionAnalyticsTab from '../../components/analytics-tab';
import ConfigurationSpaceView from '../../components/configuration-space-view';
import { roleAtLeast, useCompositionRole } from '../../hooks/useCompositionRole';
import { saveBlob, saveText } from '../../utils/download';
import { useCardComposition, type LoadedComposition } from './hooks';
import FocusTrapLayer from '../../../core/components/focus-trap-layer';

type TabId = 'overview' | CompositionTabSegment;

/** Whether what the current evaluation found points into the text, so the text is worth reading. */
const findsInText = (version: CompositionVersionView) =>
  version.evaluations.some(
    evaluation =>
      evaluation.current && evaluation.diagnostics.some(diagnostic => diagnostic.span !== null)
  );

const shortId = (id: string) => id.slice(0, 8);

const actionClass =
  'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none';

/** An absolute address for a gateway path (the API base may be relative to this page). */
function gatewayUrl(path: string): string {
  const base = config.apiBaseUrl.replace(/\/$/, '');
  const absolute = /^https?:\/\//.test(base) ? base : `${window.location.origin}${base}`;
  return `${absolute}${path}`;
}

/**
 * Where the shown version comes from, in SPHERE's dotted line: the composition it was forked from (a link while the reader
 * may open it), the run or the binding it was derived from.
 */
function Lineage({
  org,
  version,
  sourceReadable,
  member,
}: {
  org: string;
  version: CompositionVersionView;
  sourceReadable: boolean;
  member: boolean;
}) {
  const lines: ReactNode[] = [];
  const forked = version.forked_from;
  if (forked) {
    const known = forked.organization && forked.slug;
    const text = known
      ? `Forked from ${forked.name ?? forked.slug}${forked.label ? ` (version ${forked.label})` : ''} · ${forked.organization!.displayName}`
      : 'Forked from another composition';
    const suffix = forked.droppedProblem ? ', without its problem' : '';
    lines.push(
      known && sourceReadable ? (
        <Link
          key="forked"
          to={compositionPath(forked.organization!.name, forked.slug!, undefined, {
            version: forked.label ?? undefined,
          })}
          className="cursor-pointer text-left underline decoration-dotted hover:text-tp-ink"
        >
          {text}
          {suffix}
        </Link>
      ) : (
        <span key="forked">
          {text}
          {suffix}
        </span>
      )
    );
  }
  const derivation = version.derivation;
  if (derivation?.source === 'run' && derivation.run) {
    lines.push(
      <span key="derived">
        Derived from{' '}
        {member ? (
          <Link
            to={runPath(org, derivation.run.id)}
            className="underline decoration-dotted hover:text-tp-ink"
          >
            run {shortId(derivation.run.id)}
          </Link>
        ) : (
          `run ${shortId(derivation.run.id)}`
        )}
        {derivation.point !== null ? `, point ${derivation.point}` : ''}
      </span>
    );
  } else if (derivation) {
    lines.push(
      <span key="derived">
        Derived from a binding of problem version {derivation.revision.revision}
      </span>
    );
  }
  return lines.length ? (
    <ul aria-label="Lineage" className="mt-1 flex flex-col gap-0.5 text-xs text-tp-steel">
      {lines.map((line, index) => (
        <li key={index}>{line}</li>
      ))}
    </ul>
  ) : null;
}

/** The Overview of a member: the renderer's catalog, architecture and workflow, and the way to the linked problem. */
function MemberOverview({
  org,
  model,
  version,
  candidates,
  upstream,
}: {
  org: string;
  model: CompositionViewModel;
  version: CompositionVersionView | null;
  candidates: { status: 'loading' | 'error'; marker: string; retry: () => void } | null;
  upstream: RendererUpstream | null;
}) {
  const link = version?.problem ?? null;
  const problemHref =
    link && model.status.problemReadable
      ? problemPath(org, link.problem.slug, undefined, { version: link.revision.revision })
      : null;
  const highlightHref =
    link && model.status.problemReadable && model.version
      ? problemPath(org, link.problem.slug, 'candidates', {
          version: link.revision.revision,
          composition: model.identity.slug,
          compositionVersion: model.version.label,
        })
      : null;
  const editorHref =
    highlightHref && link && model.version
      ? problemEditorPath(org, {
          problem: link.problem.slug,
          revision: link.revision.revision,
          composition: model.identity.slug,
          compositionVersion: model.version.label,
        })
      : null;
  return (
    <div className="flex flex-col gap-6">
      {highlightHref && (
        <div className="flex flex-wrap items-center gap-2">
          <Link to={highlightHref} className={actionClass}>
            Show on the problem
          </Link>
          {editorHref && (
            <Link to={editorHref} className={actionClass}>
              Open on its problem in the editor
            </Link>
          )}
          <span className="text-xs text-tp-steel">
            Opens the problem version this one links, with the candidates it chose selected.
          </span>
        </div>
      )}
      <CompositionRenderer
        model={model}
        mode="catalog"
        hideSections={['identity']}
        problemHref={problemHref}
        runHref={run => runPath(org, run)}
        upstream={upstream}
      />
      {model.version && (
        <>
          <CompositionRenderer model={model} mode="architecture" upstream={upstream} />
          <CompositionRenderer model={model} mode="workflow" />
          {candidates?.status === 'loading' && (
            <p className="text-xs text-tp-steel" role="status">
              Loading the candidates of the linked problem…
            </p>
          )}
          {candidates?.status === 'error' && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
            >
              {`The candidates of the linked problem couldn’t be loaded${candidates.marker}.`}
              <button type="button" onClick={candidates.retry} className={actionClass}>
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** SPHERE's Overview: the drawing, and the "Show details" sidebar with the composition's tree and its YAML source. */
function Overview({
  org,
  slug,
  model,
  version,
  member,
  candidates,
}: {
  org: string;
  slug: string;
  model: CompositionViewModel;
  version: CompositionVersionView | null;
  member: boolean;
  candidates: { status: 'loading' | 'error'; marker: string; retry: () => void } | null;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The version's upstream plans and offering as the gateway stored them (members and visitors alike): stored data only.
  const upstream = useResource<RendererUpstream | null>(
    `composition-upstream:${org}/${slug}/${version?.id ?? 'none'}`,
    async () => (version ? loadUpstream(org, slug, version.id).catch(() => null) : null)
  );
  const yaml = useResource<string | null>(
    `composition-yaml:${org}/${slug}/${version?.id ?? 'none'}:${sidebarOpen}`,
    async () => (sidebarOpen && version ? compositionsApi.content(org, slug, version.id) : null)
  );
  const analytics = (version?.analytics ?? null) as CompositionAnalytics | null;

  const drawing = member ? (
    <MemberOverview
      org={org}
      model={model}
      version={version}
      candidates={candidates}
      upstream={upstream.data ?? null}
    />
  ) : (
    <CompositionRenderer model={model} mode="showcase" upstream={upstream.data ?? null} />
  );
  const details = (
    <div className="space-y-4">
      {analytics ? (
        <CompositionTree analytics={analytics} />
      ) : (
        version && (
          <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-4 text-xs text-tp-steel">
            The analytics of this version are not available.
          </div>
        )
      )}
      {yaml.data && <YamlSourcePanel yamlText={yaml.data} title="Composition2Yaml source" />}
      {yaml.status === 'loading' && sidebarOpen && version && (
        <p className="text-xs text-tp-steel" role="status">
          Loading the source…
        </p>
      )}
    </div>
  );

  return (
    <>
      {version && (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setSidebarOpen(open => !open)}
            aria-expanded={sidebarOpen}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
          >
            <svg
              className={`h-4 w-4 transition-transform duration-300 ${sidebarOpen ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
              />
            </svg>
            {sidebarOpen ? 'Hide details' : 'Show details'}
          </button>
        </div>
      )}
      <div className="flex flex-col gap-6 md:flex-row">
        <div className="min-w-0 flex-1 rounded-xl border border-tp-hairline bg-tp-canvas p-4">
          {drawing}
        </div>
        <AnimatePresence initial={false}>
          {sidebarOpen && (
            <motion.aside
              key="sidebar-desktop"
              aria-label="Details"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 360, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="hidden overflow-hidden md:block"
            >
              <div className="w-[360px]">{details}</div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {sidebarOpen && (
          <FocusTrapLayer key="sidebar-mobile" onEscape={() => setSidebarOpen(false)}>
            <motion.div
              key="sidebar-mobile"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-50 flex items-end justify-center bg-tp-ink/40 md:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="Details"
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-tp-canvas p-5 shadow-elevation-4"
                onClick={event => event.stopPropagation()}
              >
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-tp-ink">Details</h3>
                  <button
                    type="button"
                    aria-label="Close the details"
                    onClick={() => setSidebarOpen(false)}
                    className="cursor-pointer rounded-full p-1 text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink"
                  >
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {details}
              </motion.div>
            </motion.div>
          </FocusTrapLayer>
        )}
      </AnimatePresence>
    </>
  );
}

function CardBody({
  org,
  slug,
  tab,
  loaded,
  reload,
}: {
  org: string;
  slug: string;
  tab: TabId;
  loaded: LoadedComposition;
  reload: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useSearchParams();
  const { user } = useAuth();
  const { addToast } = useToast();
  const { addRecentComposition } = useRecentItems();
  const { downloadVersions } = useCompositionsApi();
  const roleIn = useCompositionRole();
  const { composition, etag, versions } = loaded;
  const role = roleIn(org);
  const member = role !== null;
  const canWrite = roleAtLeast(role, 'MEMBER');
  const canAdminister = roleAtLeast(role, 'ADMIN');
  const reader = user?.id ?? 'anonymous';

  const picked = pickVersion(versions, query.get('version'));
  const shown = useResource<{ version: CompositionVersionView; content?: string } | null>(
    `composition-version:${reader}:${org}/${slug}/${picked?.id ?? 'none'}`,
    async () => {
      if (!picked) return null;
      const version = await compositionsApi.version(org, slug, picked.id, { document: true });
      return member && findsInText(version)
        ? { version, content: await compositionsApi.content(org, slug, version.id) }
        : { version };
    }
  );
  const version = shown.data?.version ?? null;
  const source = member ? factsSource(version) : null;
  const facts = useResource<ProblemFacts | null>(
    `composition-facts:${org}/${source ? `${source.problem}@${source.revision}/${source.compilation}` : 'none'}`,
    async () =>
      source ? problemFactsApi.get(org, source.problem, source.revision, source.compilation) : null
  );
  const model = compositionViewModel({
    composition,
    version,
    facts: facts.data ?? null,
    reader: member ? 'member' : 'public',
    content: shown.data?.content,
  });
  const factsFailure = facts.status === 'error' ? classifyAuthError(facts.error) : null;
  const candidates =
    !source || facts.status === 'ready'
      ? null
      : {
          status: facts.status as 'loading' | 'error',
          marker: factsFailure ? marker(factsFailure) : '',
          retry: facts.reload,
        };

  // Whether the composition the shown version was forked from opens for this reader: then the lineage links to it.
  const forked = version?.forked_from;
  const forkSource =
    forked?.organization && forked.slug ? `${forked.organization.name}/${forked.slug}` : null;
  const sourceReadable = useResource<boolean>(
    `composition-fork-source:${reader}:${forkSource ?? 'none'}`,
    async () => {
      if (!forkSource || !forked?.organization || !forked.slug) return false;
      try {
        await compositionsApi.get(forked.organization.name, forked.slug);
        return true;
      } catch {
        return false;
      }
    }
  );

  // The version the gateway said links no problem after all (422 composition_not_linked): its Analysis tab goes.
  const [unlinked, setUnlinked] = useState<string | null>(null);
  const analysable =
    member && version !== null && model.modes.includes('calculator') && unlinked !== version.id;
  const analysisModel = analysable
    ? model
    : {
        ...model,
        modes: model.modes.filter(mode => mode !== 'calculator' && mode !== 'configurator'),
      };

  const [forking, setForking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [link, setLink] = useState<{ url: string; description?: string } | null>(null);

  // A visitor who asked to fork comes back signed in with `?fork=1`: the modal opens once and the address forgets it.
  const wantsFork = query.get('fork') === '1';
  useEffect(() => {
    if (!wantsFork || !user || !version) return;
    setForking(true);
    setQuery(
      current => {
        const next = new URLSearchParams(current);
        next.delete('fork');
        return next;
      },
      { replace: true }
    );
  }, [wantsFork, user, version, setQuery]);

  // A message another page left for this one (a creation, say) is said once, as a toast.
  const said = useRef<string | null>(null);
  const handed = (location.state as { toast?: string } | null)?.toast ?? null;
  useEffect(() => {
    if (!handed || said.current === handed) return;
    said.current = handed;
    addToast({ kind: SYSTEM_TOAST, title: handed });
  }, [handed, addToast]);

  useEffect(() => {
    if (!user) return;
    addRecentComposition({
      id: `${org}/${slug}`,
      name: composition.name,
      orgId: org,
      orgName: composition.organization.name,
    });
  }, [user, org, slug, composition.name, composition.organization.name, addRecentComposition]);

  const versionQuery = query.get('version') ?? undefined;
  const tabTo = (id: TabId) =>
    compositionPath(org, slug, id === 'overview' ? undefined : id, { version: versionQuery });
  /** The standalone editor on the version shown (the latest one when none is named), in a mode. */
  const edit = (mode: 'code' | 'visual') =>
    void navigate(
      editorPath({ source: { org, slug }, version: versionQuery ?? picked?.label, mode })
    );

  const fork = () => {
    if (user) {
      setForking(true);
      return;
    }
    const back = `${compositionPath(org, slug, undefined, { version: picked?.label })}`;
    void navigate('/authentication', {
      state: { from: `${back}${back.includes('?') ? '&' : '?'}fork=1` },
    });
  };

  const permanentLink = `${window.location.origin}${permalinkPath(composition.id)}`;

  const copyYamlLink = () => {
    if (!picked) return;
    if (composition.visibility === 'private') {
      setLink({
        url: permanentLink,
        description:
          'This composition is private, so its YAML file is only served to signed-in members of its organization. This is its permanent link instead: members open every version, everyone else is told there is nothing there.',
      });
      return;
    }
    setLink({
      url: gatewayUrl(
        `/v1/organizations/${encodeURIComponent(org)}/compositions/${encodeURIComponent(slug)}/versions/${encodeURIComponent(picked.id)}/content`
      ),
    });
  };

  const downloadCurrent = async () => {
    if (!picked) return;
    try {
      saveText(await compositionsApi.content(org, slug, picked.id), `${slug}-${picked.label}.yaml`);
    } catch (caught) {
      void customAlert(
        `The version could not be downloaded: ${readApiError(caught).message}`,
        'error'
      );
    }
  };

  const downloadAll = async () => {
    try {
      saveBlob(await downloadVersions(org, slug), `${slug}.zip`);
    } catch (caught) {
      void customAlert(
        `The versions could not be downloaded: ${readApiError(caught).message}`,
        'error'
      );
    }
  };

  const tabs: ShellTab[] = useMemo(() => {
    const list: Array<{ id: TabId; label: string; shown: boolean }> = [
      { id: 'overview', label: 'Overview', shown: true },
      { id: 'analytics', label: 'Analytics', shown: true },
      {
        id: 'configuration',
        label: 'Configuration',
        shown: analysable || tab === 'configuration',
      },
      { id: 'versions', label: 'Versions', shown: true },
      { id: 'settings', label: 'Settings', shown: canWrite || tab === 'settings' },
    ];
    return list
      .filter(item => item.shown)
      .map(item => ({ id: item.id, label: item.label, to: tabTo(item.id) }));
    // `tabTo` reads only the address and the composition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, analysable, tab, org, slug, versionQuery]);

  const overflow: OverflowAction[] = [
    ...(version ? [{ label: 'Fork', onSelect: fork }] : []),
    ...(canWrite
      ? [
          {
            label: 'New version in the visual editor',
            onSelect: () => edit('visual'),
          },
          {
            label: 'New version in the code editor',
            onSelect: () => edit('code'),
          },
          { label: 'Upload a new version', onSelect: () => setImporting(true) },
          { label: 'Derive from a run', to: runsPath(org) },
        ]
      : []),
  ];

  const updated = picked ? formatDistanceToNow(parseISO(picked.created_at)) : null;
  const subtitle = (
    <>
      {picked && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-tp-steel">
          {versions.length > 1 ? (
            <select
              aria-label="Version"
              value={picked.id}
              onChange={event =>
                setQuery(current => {
                  const next = new URLSearchParams(current);
                  next.set(
                    'version',
                    versions.find(item => item.id === event.target.value)?.label ?? ''
                  );
                  return next;
                })
              }
              className="h-7 cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs font-medium text-tp-ink focus:border-tp-primary focus:outline-none"
            >
              {versions.map((item, index) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                  {index === 0 ? ' · latest' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-lg border border-tp-input-border bg-tp-input-bg px-2 py-1 text-xs font-medium text-tp-ink">
              {picked.label}
            </span>
          )}
          <span>· Updated {updated} ago</span>
        </div>
      )}
      {!picked && <p className="mt-1 text-sm text-tp-steel">No version yet</p>}
      {composition.archived && (
        <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
          Archived
        </span>
      )}
      {version && (
        <Lineage
          org={org}
          version={version}
          member={member}
          sourceReadable={sourceReadable.data === true}
        />
      )}
    </>
  );

  const versionFailure = shown.status === 'error' ? classifyAuthError(shown.error) : null;
  const reading =
    (tab === 'overview' || tab === 'configuration') &&
    picked !== null &&
    shown.status === 'loading';

  return (
    <>
      <Helmet>
        <title>OpenBinding - {composition.name}</title>
      </Helmet>
      <ResourceCardShell
        crumbs={[
          {
            label: composition.organization.name,
            to: member ? compositionsPath(org) : orgPath(org, 'compositions'),
          },
          { label: composition.name },
        ]}
        title={composition.name}
        subtitle={subtitle}
        actions={
          <>
            {user && <FollowButton org={org} composition={slug} />}
            {version && (
              <button type="button" onClick={fork} className={actionClass}>
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M8.25 6.75a2.25 2.25 0 100-4.5 2.25 2.25 0 000 4.5zm0 0v3.75m0 0a2.25 2.25 0 102.25 2.25M8.25 10.5a2.25 2.25 0 002.25 2.25m6-9v3.75m0 0a2.25 2.25 0 11-2.25 2.25m2.25-2.25a2.25 2.25 0 00-2.25 2.25m0 0v5.25a2.25 2.25 0 01-2.25 2.25h-1.5"
                  />
                </svg>
                Fork
              </button>
            )}
            {canWrite && (
              <NewVersionMenu
                onVisualEditor={() => edit('visual')}
                onCodeEditor={() => edit('code')}
                onUploadFile={() => setImporting(true)}
                deriveHref={runsPath(org)}
              />
            )}
          </>
        }
        primaryAction={
          <GetCompositionMenu
            permanentLink={permanentLink}
            hasVersion={picked !== null}
            onCopyYamlLink={copyYamlLink}
            onDownloadCurrent={() => void downloadCurrent()}
            onDownloadAll={downloadAll}
          />
        }
        overflow={overflow}
        stats={compositionStats({
          analytics: (version?.analytics ?? null) as CompositionAnalytics | null,
          cost: version?.values?.cost,
          valuesStatus: version?.values_status ?? null,
          versions: versions.length,
        })}
        tabs={tabs}
        activeTab={tab}
        tabsLabel="Composition sections"
      >
        {reading && (
          <div role="status" aria-busy="true" className="py-12 text-center text-sm text-tp-steel">
            Loading the version…
          </div>
        )}
        {(tab === 'overview' || tab === 'configuration') && versionFailure && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {`Version ${picked?.label ?? ''} couldn’t be loaded${marker(versionFailure)}.`}
            <button
              type="button"
              onClick={() => {
                shown.reload();
                reload();
              }}
              className={actionClass}
            >
              Retry
            </button>
          </div>
        )}
        {tab === 'overview' && (!picked || shown.status === 'ready') && (
          <Overview
            org={org}
            slug={slug}
            model={model}
            version={version}
            member={member}
            candidates={candidates}
          />
        )}
        {tab === 'configuration' && (!picked || shown.status === 'ready') && (
          <ConfigurationSpaceView
            org={org}
            composition={composition}
            model={analysisModel}
            canDerive={canWrite}
            candidates={candidates}
            onNotLinked={() => setUnlinked(version?.id ?? null)}
          />
        )}
        {tab === 'analytics' && (
          <CompositionAnalyticsTab
            org={org}
            composition={slug}
            refresh={versions.map(item => item.id).join(',')}
          />
        )}
        {tab === 'versions' && (
          <div className="space-y-4">
            <CompositionVersionGraph
              org={org}
              slug={slug}
              compositionId={composition.id}
              refreshKey={versions.map(item => item.id).join(',')}
              currentVersionId={picked?.id ?? null}
              onSelectVersion={id =>
                setQuery(current => {
                  const next = new URLSearchParams(current);
                  next.set('version', versions.find(item => item.id === id)?.label ?? id);
                  return next;
                })
              }
            />
            <CompositionVersionsTab
              org={org}
              composition={composition}
              versions={versions}
              shown={picked?.id ?? null}
              canCreate={canWrite}
              member={member}
              onChanged={message => {
                addToast({ kind: SYSTEM_TOAST, title: message });
                shown.reload();
                reload();
              }}
            />
          </div>
        )}
        {tab === 'settings' && (
          <CompositionSettingsTab
            key={composition.slug}
            org={org}
            organizationName={composition.organization.name}
            composition={composition}
            etag={etag}
            canWrite={canWrite}
            canAdminister={canAdminister}
            onChanged={message => {
              if (message) addToast({ kind: SYSTEM_TOAST, title: message });
              reload();
            }}
            onDeleted={() => {
              addToast({ kind: SYSTEM_TOAST, title: `Composition “${composition.name}” deleted.` });
              void navigate(compositionsPath(org));
            }}
          />
        )}
      </ResourceCardShell>

      {link && (
        <PricingLinkModal
          linkUrl={link.url}
          description={link.description}
          onClose={() => setLink(null)}
        />
      )}
      {importing && (
        <CompositionImportModal
          org={org}
          slug={slug}
          compositionName={composition.name}
          onClose={() => setImporting(false)}
          onImported={(label, created) => {
            setImporting(false);
            addToast({
              kind: SYSTEM_TOAST,
              title: created
                ? `Version ${label} sealed`
                : `Version ${label} already held this text`,
            });
            reload();
            void navigate(compositionPath(org, slug, 'versions', { version: label }));
          }}
        />
      )}
      {forking && version && (
        <ForkCompositionModal
          org={org}
          composition={composition}
          version={version}
          onClose={() => setForking(false)}
          onSuccess={result => {
            setForking(false);
            addToast({
              kind: SYSTEM_TOAST,
              title: 'Composition forked',
              message: result.droppedProblem
                ? `${result.composition.name} is a private composition of ${result.composition.organization.name}, without the problem.`
                : `${result.composition.name} is a private composition of ${result.composition.organization.name}.`,
            });
            void navigate(
              compositionPath(result.composition.organization.slug, result.composition.slug)
            );
          }}
        />
      )}
    </>
  );
}

/**
 * A composition (`/compositions/:org/:composition/:tab?`): SPHERE's card page for every reader, at the version `?version=`
 * names (an id, a label or an ordinal; the latest when none, or when the one named is not listed). Any other tab, and a
 * composition that is missing or that the reader may not read, is the same in-place 404.
 */
export default function CompositionCardPage() {
  const { org = '', composition: slug = '', tab } = useParams();
  const { state, reload } = useCardComposition(org, slug);
  if (tab !== undefined && !isCompositionTabSegment(tab)) return <NotFoundPage />;
  if (state.status === 'missing') return <NotFoundPage />;
  if (state.status === 'error')
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center md:px-8">
        <div
          role="alert"
          className="mx-auto max-w-[28rem] rounded-xl border border-red-200 bg-red-50 p-6"
        >
          <p className="text-sm font-medium text-red-800">The composition couldn’t be loaded.</p>
          <p className="mt-1 text-xs text-red-700">
            The gateway didn’t answer for this composition. This says nothing about your access.{' '}
            {state.message}
          </p>
          <button
            type="button"
            onClick={reload}
            className="mt-4 cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-4 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      </div>
    );
  const loaded = state.status === 'ready' ? state.loaded : state.loaded;
  if (!loaded) return <PricingCardSkeleton />;
  return (
    <CardBody
      key={`${org}/${slug}`}
      org={org}
      slug={slug}
      tab={(tab as CompositionTabSegment | undefined) ?? 'overview'}
      loaded={loaded}
      reload={reload}
    />
  );
}
