// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a problem instead of a pricing, on the card shell the composition page shares (core resource-card-shell):
// SPHERE's breadcrumb, title, version select or chip with "· Updated X ago" and a line saying where the version came from;
// a Sealed chip; the actions are OpenBinding's ("Run this version" first, "New version" ▾ with the problem editor and an
// upload, "Add to study", and a "Get problem" ▾ menu: the exact reference, the package, the compiled form, every version
// zipped); the tiles count tasks, candidates, combinations and versions. The tab is in the address
// (`/problems/:org/:problem/:tab?`), the version in `?version=` (a number, or a package fingerprint or an id the gateway
// resolves). Problems are private to their organization: no Follow, Fork, visibility or public view, and a problem that is
// missing, of another organization, or a version that does not exist is the same in-place 404. Who may do what comes from
// OpenBinding's roles (MEMBER writes and runs, ADMIN deletes).

import { formatDistanceToNow, parseISO } from 'date-fns';
import JSZip from 'jszip';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { classifyAuthError, marker } from '../../../core/api/errors';
import ResourceCardShell, {
  type OverflowAction,
  type ShellTab,
} from '../../../core/components/resource-card-shell';
import PricingCardSkeleton from '../../../core/components/skeletons/pricing-card-skeleton';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import { useRecentItems } from '../../../core/hooks/useRecentItems';
import NotFoundPage from '../../../core/pages/page-not-found';
import {
  isProblemTabSegment,
  problemEditorPath,
  problemPath,
  problemsPath,
  type ProblemTabSegment,
} from '../../../../routes/paths/problems';
import { newStudyPath } from '../../../../routes/paths/studies';
import { useResource } from '../../../../utils/useResource';
import { problemsApi, type ProblemRevision } from '../../api/problemsApi';
import CandidatesExplorer from '../../components/candidates-explorer';
import CompositionsTab from '../../components/compositions-tab';
import GetProblemMenu from '../../components/get-problem-menu';
import NewVersionMenu from '../../components/new-version-menu';
import OverviewTab from '../../components/overview-tab';
import ProblemImportModal from '../../components/problem-import-modal';
import RunsTab from '../../components/runs-tab';
import SettingsTab from '../../components/settings-tab';
import SourceTab from '../../components/source-tab';
import VersionsTab from '../../components/versions-tab';
import { useProblemOrganization, type ProblemAccess } from '../../hooks/useProblemRole';
import { ORIGIN_LINES, type ProblemOrg } from '../../types';
import { saveBlob, saveBytes } from '../../utils/download';
import { loadModel, modelKey, type ModelState } from '../../utils/modelLoader';
import { exactReference, powerText } from '../../utils/problemsModel';
import { runLaunchOf } from '../../utils/runTarget';
import { useCardProblem, type LoadedProblem } from './hooks';

type TabId = 'overview' | ProblemTabSegment;

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'versions', label: 'Versions' },
  { id: 'runs', label: 'Runs' },
  { id: 'compositions', label: 'Compositions' },
  { id: 'source', label: 'Source' },
  { id: 'settings', label: 'Settings' },
];

/** The tabs that show one version of the problem: without a version they say how to make one. */
const VERSION_TABS: ReadonlySet<TabId> = new Set(['overview', 'candidates', 'source']);

const actionClass =
  'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none';

/** A failed download, in words the Get menu shows. */
const downloadFailure = (caught: unknown) =>
  new Error(`The download didn’t finish${marker(classifyAuthError(caught))}.`);

function CardBody({
  org,
  tab,
  loaded,
  access,
  reload,
}: {
  org: ProblemOrg;
  tab: TabId;
  loaded: LoadedProblem;
  access: ProblemAccess;
  reload: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useSearchParams();
  const { addToast } = useToast();
  const { addRecentProblem } = useRecentItems();
  const { item, revisions, etag } = loaded;
  const { canCreate, canAdminister, role } = access;
  const [uploading, setUploading] = useState(false);

  // The version shown: the one the address names (a number; a fingerprint or an id is asked of the gateway), else the latest.
  const named = query.get('version') ?? '';
  const found = named
    ? revisions.find(candidate => String(candidate.revision) === named)
    : revisions[0];
  const ask = named !== '' && !found;
  const remote = useResource<ProblemRevision | null>(
    `problem-revision:${org.slug}/${item.slug}/${named}:${ask ? 'ask' : 'skip'}`,
    async () => (ask ? problemsApi.revision(org.slug, item.slug, named) : null)
  );
  const revision = found ?? remote.data ?? undefined;
  const model = useResource<ModelState | null>(
    revision ? modelKey(org.slug, item.slug, revision) : `model:${org.slug}/${item.slug}/none`,
    async () => (revision ? loadModel(org.slug, item.slug, revision.revision) : null)
  );
  const compilation = model.data?.state === 'ready' ? model.data.compilation : null;

  // A message another page left for this one (a creation, say) is said once, as a toast.
  const said = useRef<string | null>(null);
  const handed = (location.state as { toast?: string } | null)?.toast ?? null;
  useEffect(() => {
    if (!handed || said.current === handed) return;
    said.current = handed;
    addToast({ kind: SYSTEM_TOAST, title: handed });
  }, [handed, addToast]);

  useEffect(() => {
    addRecentProblem({ id: item.slug, name: item.name, orgId: org.slug, orgName: org.name });
  }, [addRecentProblem, item.slug, item.name, org.slug, org.name]);

  const versionQuery = query.get('version') ?? undefined;
  const tabs: ShellTab[] = useMemo(
    () =>
      TABS.map(entry => ({
        id: entry.id,
        label: entry.label,
        to: problemPath(org.slug, item.slug, entry.id === 'overview' ? undefined : entry.id, {
          version: versionQuery,
        }),
      })),
    [org.slug, item.slug, versionQuery]
  );

  if (ask && remote.status === 'loading') return <PricingCardSkeleton />;
  if (ask && !revision) return <NotFoundPage />;

  const runHref = revision ? runLaunchOf(org.slug, item.slug, revision.revision) : null;
  const studyHref = revision
    ? newStudyPath(org.slug, { problem: item.slug, revision: revision.revision })
    : null;
  const editorHref = problemEditorPath(org.slug, {
    problem: item.slug,
    revision: revision?.revision,
  });
  const reference = revision ? exactReference(item.slug, revision) : '';

  const downloadPackage = async () => {
    if (!revision) return;
    try {
      saveBytes(
        await problemsApi.source(org.slug, item.slug, revision.revision),
        `${item.slug}-v${revision.revision}.bim.zip`,
        'application/vnd.bim+zip'
      );
    } catch (caught) {
      throw downloadFailure(caught);
    }
  };
  const downloadCompiled =
    revision && compilation
      ? async () => {
          try {
            const ir = await problemsApi.ir(org.slug, item.slug, revision.revision, compilation.id);
            saveBytes(
              new TextEncoder().encode(JSON.stringify(ir.ir, null, 2)),
              `${item.slug}-v${revision.revision}-compiled.json`,
              'application/json'
            );
          } catch (caught) {
            throw downloadFailure(caught);
          }
        }
      : undefined;
  const downloadAll = async () => {
    try {
      const zip = new JSZip();
      for (const entry of revisions)
        zip.file(
          `${item.slug}-v${entry.revision}.bim.zip`,
          await problemsApi.source(org.slug, item.slug, entry.revision)
        );
      saveBlob(await zip.generateAsync({ type: 'blob' }), `${item.slug}.zip`);
    } catch (caught) {
      throw downloadFailure(caught);
    }
  };

  const updated = revision ? formatDistanceToNow(parseISO(revision.created_at)) : null;
  const origin = revision ? revisions.find(entry => entry.id === revision.id)?.origin : undefined;
  const subtitle = (
    <>
      {revision ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-tp-steel">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
              />
            </svg>
            Sealed
          </span>
          {revisions.length > 1 ? (
            <select
              aria-label="Version"
              value={String(revision.revision)}
              onChange={event =>
                setQuery(current => {
                  const next = new URLSearchParams(current);
                  next.set('version', event.target.value);
                  return next;
                })
              }
              className="h-7 cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs font-medium text-tp-ink focus:border-tp-primary focus:outline-none"
            >
              {revisions.map((candidate, index) => (
                <option key={candidate.id} value={candidate.revision}>
                  Version {candidate.revision}
                  {index === 0 ? ' · latest' : ''}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded-lg border border-tp-input-border bg-tp-input-bg px-2 py-1 text-xs font-medium text-tp-ink">
              Version {revision.revision}
            </span>
          )}
          <span>· Updated {updated} ago</span>
        </div>
      ) : (
        <p className="mt-1 text-sm text-tp-steel">No version yet</p>
      )}
      {origin && <p className="mt-1 text-xs text-tp-steel">{ORIGIN_LINES[origin]}</p>}
    </>
  );

  const overflow: OverflowAction[] = canCreate
    ? [
        { label: 'New version in the problem editor', to: editorHref },
        { label: 'Upload a new version', onSelect: () => setUploading(true) },
        ...(studyHref ? [{ label: 'Add to study', to: studyHref }] : []),
      ]
    : [];
  const getMenu = revision ? (
    <GetProblemMenu
      reference={reference}
      onDownloadPackage={downloadPackage}
      onDownloadCompiled={downloadCompiled}
      onDownloadAll={downloadAll}
    />
  ) : null;
  const run =
    canCreate && runHref ? (
      <Link
        to={runHref}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-tp-accent px-3 text-xs font-semibold text-tp-on-primary shadow-sm transition-colors hover:bg-tp-primary-deep focus:ring-2 focus:ring-tp-primary/40 focus:outline-none"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z"
          />
        </svg>
        Run this version
      </Link>
    ) : null;

  const stats = [
    { label: 'Tasks', value: compilation ? compilation.analysis.tasks.toLocaleString('en') : '—' },
    {
      label: 'Candidates',
      value: compilation ? compilation.analysis.candidates.toLocaleString('en') : '—',
    },
    {
      label: 'Combinations',
      value: compilation ? `≈ ${powerText(compilation.analysis.bindingSpace)}` : '—',
    },
    { label: 'Versions', value: String(revisions.length) },
  ];

  return (
    <>
      <Helmet>
        <title>OpenBinding - {item.name}</title>
      </Helmet>
      <ResourceCardShell
        crumbs={[{ label: org.name, to: problemsPath(org.slug) }, { label: item.name }]}
        title={item.name}
        subtitle={subtitle}
        actions={
          <>
            {canCreate && (
              <NewVersionMenu editorHref={editorHref} onUploadFile={() => setUploading(true)} />
            )}
            {canCreate && studyHref && (
              <Link to={studyHref} className={actionClass}>
                Add to study
              </Link>
            )}
            {run && getMenu}
          </>
        }
        primaryAction={run ?? getMenu}
        overflow={overflow}
        stats={stats}
        tabs={tabs}
        activeTab={tab}
        tabsLabel="Problem sections"
      >
        {!canCreate && (
          <p
            role="note"
            className="mb-4 rounded-lg border border-tp-hairline bg-tp-surface px-3 py-2 text-xs text-tp-slate"
          >
            {role ? (
              <>
                You’re {role === 'VIEWER' ? 'a' : 'an'} <strong>{role}</strong>.{' '}
              </>
            ) : null}
            You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.
          </p>
        )}
        {VERSION_TABS.has(tab) && !revision && (
          <section
            aria-labelledby="cd-empty"
            className="rounded-xl border border-dashed border-tp-hairline-strong p-6 text-center"
          >
            <h2 id="cd-empty" className="text-base font-medium text-tp-ink">
              No versions yet
            </h2>
            <p className="mt-1 text-sm text-tp-steel">
              A version is a sealed BIM package. Upload one, or write it in the problem editor, to
              be able to run this problem.
            </p>
            {canCreate && (
              <button
                type="button"
                onClick={() => setUploading(true)}
                className="mt-4 cursor-pointer rounded-lg bg-tp-accent px-4 py-2 text-sm font-medium text-tp-on-primary hover:bg-tp-primary-deep"
              >
                Upload a version
              </button>
            )}
          </section>
        )}
        {tab === 'overview' && revision && (
          <OverviewTab org={org.slug} content={loaded} revision={revision} model={model} />
        )}
        {tab === 'candidates' && revision && (
          <CandidatesExplorer org={org.slug} content={loaded} revision={revision} model={model} />
        )}
        {tab === 'versions' && (
          <VersionsTab
            org={org.slug}
            content={loaded}
            shown={revision?.revision ?? null}
            runOf={number => runLaunchOf(org.slug, item.slug, number)}
            canCreate={canCreate}
          />
        )}
        {tab === 'runs' && (
          <RunsTab org={org.slug} content={loaded} runHref={runHref} canCreate={canCreate} />
        )}
        {tab === 'compositions' && <CompositionsTab org={org.slug} item={item} />}
        {tab === 'source' && revision && (
          <SourceTab key={revision.id} org={org.slug} item={item} revision={revision} />
        )}
        {tab === 'settings' && (
          <SettingsTab
            key={`${item.id}/${etag ?? ''}`}
            org={org}
            item={item}
            etag={etag}
            canEdit={canCreate}
            canAdminister={canAdminister}
            onSaved={reload}
            onDeleted={name => {
              addToast({ kind: SYSTEM_TOAST, title: `Problem “${name}” deleted.` });
              void navigate(problemsPath(org.slug));
            }}
          />
        )}
      </ResourceCardShell>

      {uploading && (
        <ProblemImportModal
          mode="version"
          org={org}
          item={item}
          onClose={() => setUploading(false)}
          onSaved={saved => {
            setUploading(false);
            addToast({
              kind: SYSTEM_TOAST,
              title: saved.created
                ? `Saved as version ${saved.revision.revision}.`
                : `Unchanged: this is version ${saved.revision.revision}.`,
            });
            reload();
            void navigate(
              problemPath(org.slug, item.slug, tab === 'overview' ? undefined : tab, {
                version: saved.revision.revision,
              }),
              { replace: true }
            );
          }}
        />
      )}
    </>
  );
}

function ProblemCard({
  org,
  slug,
  tab,
  access,
}: {
  org: ProblemOrg;
  slug: string;
  tab: TabId;
  access: ProblemAccess;
}) {
  const { state, reload } = useCardProblem(org.slug, slug);
  if (state.status === 'missing') return <NotFoundPage />;
  if (state.status === 'error')
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center md:px-8">
        <div
          role="alert"
          className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-6"
        >
          <p className="text-sm font-medium text-red-800">The problem couldn’t be loaded.</p>
          <p className="mt-1 text-xs text-red-700">
            The gateway didn’t answer for this problem. This says nothing about your access.{' '}
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
  if (!state.loaded) return <PricingCardSkeleton />;
  return <CardBody org={org} tab={tab} loaded={state.loaded} access={access} reload={reload} />;
}

/**
 * A problem (`problem-detail`, `/problems/:org/:problem/:tab?`): SPHERE's card page with the tabs Overview, Candidates,
 * Versions, Runs, Compositions, Source and Settings of the version `?version=` names (the latest when none). The Candidates tab
 * highlights what a composition version chose (`?composition=&compositionVersion=`). Any other tab, a problem of an
 * organization the account is not in, and a missing problem or version are the same in-place 404.
 */
export default function ProblemCardPage() {
  const { org = '', problem: slug = '', tab } = useParams();
  const { organization, loading, access } = useProblemOrganization(org);
  if (tab !== undefined && !isProblemTabSegment(tab)) return <NotFoundPage />;
  if (loading) return <PricingCardSkeleton />;
  if (!organization) return <NotFoundPage />;
  return (
    <ProblemCard
      key={`${org}/${slug}`}
      org={{ slug: organization.slug, name: organization.name }}
      slug={slug}
      tab={(tab as ProblemTabSegment | undefined) ?? 'overview'}
      access={access}
    />
  );
}
