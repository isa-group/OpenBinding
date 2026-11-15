// Design follows SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a); no code copied
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Badge } from '../../components/ui/Badge';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { compositionsApi } from '../../entities/composition/api';
import { kindLabel } from '../../entities/composition/kinds';
import { pickVersion } from '../../entities/composition/versionRef';
import { compositionViewModel } from '../../entities/composition/viewModel';
import { problemFactsApi } from '../../entities/problem/facts';
import { NewVersionMenu } from '../../features/composition-editor/NewVersionMenu';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { Gate } from '../../features/workspace/parts';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { compositionPath, compositionsPath, isCompositionTabSegment, type CompositionTabSegment } from '../../routes/paths/compositions';
import { runPath, runsPath } from '../../routes/paths/runs';
import { classifyAuthError, marker } from '../../shared/api/errors';
import type { CompositionVersionView, ProblemFacts } from '../../shared/api/types';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { CompositionMissing } from './CompositionMissing';
import { CompositionFrame } from './parts';
import { factsSource } from './factsSource';
import { AnalysisTab } from './tabs/AnalysisTab';
import { EditorTab, type EditorEntry } from './tabs/EditorTab';
import { OverviewTab, type CandidatesState } from './tabs/OverviewTab';
import { VersionsTab } from './tabs/VersionsTab';
import { relativeTime } from './time';
import { useRouteComposition, type CompositionAccess, type RouteCompositionContent } from './useRouteComposition';

type TabId = 'overview' | CompositionTabSegment;

/** The tabs built so far; Settings joins with its block. Analysis shows only for a version whose linked problem the reader can read. */
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'editor', label: 'Editor' },
  { id: 'versions', label: 'Versions' },
  { id: 'analysis', label: 'Analysis' },
];

interface ShownVersion {
  version: CompositionVersionView;
  /** The version's text, read only when the evaluation's findings need to be located in it. */
  content?: string;
}

/** Whether what the current evaluation found points into the text, so the text is worth reading. */
const findsInText = (version: CompositionVersionView) => version.evaluations.some((evaluation) => (
  evaluation.current && evaluation.diagnostics.some((diagnostic) => diagnostic.span !== null)
));

const shortId = (id: string) => id.slice(0, 8);

/** Where the shown version comes from: the composition it was forked from, the run or the binding it was derived from. */
function Lineage({ org, version, mine }: { org: string; version: CompositionVersionView; mine: (org: string) => boolean }) {
  const lines: ReactNode[] = [];
  const forked = version.forked_from;
  if (forked) {
    const source = forked.organization && forked.slug ? `${forked.organization.displayName} / ${forked.name ?? forked.slug}` : null;
    const href = forked.organization && forked.slug && mine(forked.organization.name)
      ? compositionPath(forked.organization.name, forked.slug, undefined, { version: forked.label ?? undefined })
      : null;
    lines.push(
      <li key="forked">
        {source ? <>Forked from {href ? <Link to={href}>{source}</Link> : source}{forked.label ? ` ${forked.label}` : ''}</> : 'Forked from a composition that is not shared with you'}
        {forked.droppedProblem ? ', without its problem.' : '.'}
      </li>,
    );
  }
  const derivation = version.derivation;
  if (derivation?.source === 'run' && derivation.run) {
    lines.push(
      <li key="derived">
        Derived from <Link to={runPath(org, derivation.run.id)}>run {shortId(derivation.run.id)}</Link>
        {derivation.point !== null ? `, point ${derivation.point}` : ''}.
      </li>,
    );
  } else if (derivation) {
    lines.push(<li key="derived">Derived from a binding of problem version {derivation.revision.revision}.</li>);
  }
  return lines.length ? <ul className="cmp-lineage" aria-label="Lineage">{lines}</ul> : null;
}

function CompositionBody({ organization, organizations, access, content, tab, reload }: {
  organization: Organization; organizations: readonly Organization[]; access: CompositionAccess; content: RouteCompositionContent;
  tab: CompositionTabSegment | undefined; reload: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query] = useSearchParams();
  const { composition, versions } = content;
  const org = organization.slug;
  const active: TabId = tab ?? 'overview';
  const { canCreate, role } = access;
  const toast = (location.state as { toast?: string } | null)?.toast ?? '';
  const picked = pickVersion(versions, query.get('version'));
  const shown = useResource<ShownVersion | null>(
    `composition-version:${org}/${composition.slug}/${picked?.id ?? 'none'}`,
    async () => {
      if (!picked) return null;
      const version = await compositionsApi.version(org, composition.slug, picked.id, { document: true });
      return findsInText(version) ? { version, content: await compositionsApi.content(org, composition.slug, version.id) } : { version };
    },
  );
  const open = (id: TabId, version = query.get('version') ?? undefined, entry?: EditorEntry) => void navigate(
    compositionPath(org, composition.slug, id === 'overview' ? undefined : id, { version }), { viewTransition: true, state: entry },
  );
  const updated = relativeTime(composition.updated_at);
  const version = shown.data?.version ?? null;
  const source = factsSource(version);
  const facts = useResource<ProblemFacts | null>(
    `composition-facts:${org}/${source ? `${source.problem}@${source.revision}/${source.compilation}` : 'none'}`,
    async () => (source ? problemFactsApi.get(org, source.problem, source.revision, source.compilation) : null),
  );
  const model = compositionViewModel({ composition, version, facts: facts.data ?? null, reader: 'member', content: shown.data?.content });
  const factsFailure = facts.status === 'error' ? classifyAuthError(facts.error) : null;
  const candidates: CandidatesState | null = !source || facts.status === 'ready' ? null : {
    status: facts.status, marker: factsFailure ? marker(factsFailure) : '', retry: facts.reload,
  };
  const versionFailure = shown.status === 'error' ? classifyAuthError(shown.error) : null;
  const mine = (slug: string) => organizations.some((item) => item.slug === slug);
  // The version the gateway said links no problem after all (422 composition_not_linked): its Analysis tab goes.
  const [unlinked, setUnlinked] = useState<string | null>(null);
  const analysable = version !== null && model.modes.includes('calculator') && unlinked !== version.id;
  const analysisModel = analysable ? model : { ...model, modes: model.modes.filter((mode) => mode !== 'calculator' && mode !== 'configurator') };
  // A direct address to Analysis keeps its tab, which then explains why there is nothing to explore.
  const tabs = TABS.filter((item) => item.id !== 'analysis' || analysable || active === 'analysis');
  const reading = (active === 'overview' || active === 'analysis') && picked !== null && shown.status === 'loading';

  return (
    <CompositionFrame organization={organization} trail={[{ label: 'Compositions', to: compositionsPath(org) }, { label: composition.name }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>{composition.name}</h1>
            <span className="cmp-badges">
              <Badge>{kindLabel(composition.kind)}</Badge>
              <Badge variant={composition.visibility === 'public' ? 'info' : 'default'}>{composition.visibility === 'public' ? 'Public' : 'Private'}</Badge>
              {composition.archived && <Badge variant="warning">Archived</Badge>}
            </span>
          </div>
          <div className="proj-title-line">
            <code className="cmp-slug">{composition.slug}</code>
            {updated && <span className="org-muted">Updated {updated}</span>}
          </div>
          {composition.description && <p className="cmp-description">{composition.description}</p>}
          {picked && (
            <label className="cmp-version">
              Version
              <select className="cmp-select" aria-label="Version" value={picked.id} onChange={(event) => open(active, versions.find((item) => item.id === event.target.value)?.label)}>
                {versions.map((item, index) => <option key={item.id} value={item.id}>{item.label}{index === 0 ? ' · latest' : ''}</option>)}
              </select>
            </label>
          )}
          {version && <Lineage org={org} version={version} mine={mine} />}
        </div>
        {canCreate && (
          <NewVersionMenu
            onCodeEditor={() => open('editor', undefined, { pane: 'code' })}
            onVisualEditor={() => open('editor', undefined, { pane: 'visual' })}
            onUploadFile={() => open('editor', undefined, { upload: true })}
            deriveHref={runsPath(org)}
          />
        )}
      </header>

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
        </div>
      )}
      {!canCreate && <ReadOnlyNote role={role}>You can read this composition and its versions. Sealing versions needs MEMBER.</ReadOnlyNote>}

      <TabBar items={tabs} value={active} onChange={(id) => open(id as TabId)} ariaLabel="Composition sections" prefix="cp-tab" />
      <TabPanel prefix="cp-tab" active={active}>
        {reading && (
          <div role="status" aria-busy="true" className="cmp-panel-loading"><span className="sr-only">Loading the version…</span><Skeleton variant="panel" /><Skeleton variant="card" /></div>
        )}
        {(active === 'overview' || active === 'analysis') && versionFailure && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={() => { shown.reload(); reload(); }}>Retry</Action>}>
            {`Version ${picked?.label ?? ''} couldn’t be loaded${marker(versionFailure)}.`}
          </Notice>
        )}
        {active === 'overview' && (!picked || shown.status === 'ready') && <OverviewTab org={org} model={model} version={version} candidates={candidates} />}
        {active === 'editor' && (
          <EditorTab org={org} composition={composition} version={picked ?? null} canSeal={canCreate} onSealed={reload} />
        )}
        {active === 'analysis' && (!picked || shown.status === 'ready') && (
          <AnalysisTab
            org={org}
            composition={composition}
            model={analysisModel}
            canDerive={canCreate}
            candidates={candidates}
            onNotLinked={() => setUnlinked(version?.id ?? null)}
          />
        )}
        {active === 'versions' && (
          <VersionsTab org={org} composition={composition} versions={versions} shown={picked?.id ?? null} canCreate={canCreate} onChanged={() => { shown.reload(); reload(); }} />
        )}
      </TabPanel>
    </CompositionFrame>
  );
}

function CompositionPage({ tab }: { tab: CompositionTabSegment | undefined }) {
  const route = useRouteComposition();
  const { compositionSlug, organization, waiting, content, loaded, failure, access, context } = route;

  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  const org = organization.slug;
  const trail = [{ label: 'Compositions', to: compositionsPath(org) }, { label: compositionSlug }];

  if (content.status === 'loading' && !loaded) {
    return (
      <CompositionFrame organization={organization} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the composition…</span><Skeleton variant="panel" /><Skeleton variant="card" /></div>
      </CompositionFrame>
    );
  }
  if (failure || !loaded) {
    const missing = !failure || failure.status === 404 || failure.status === 403 || failure.kind === 'not-found';
    return (
      <CompositionFrame organization={organization} trail={trail}>
        {missing ? <CompositionMissing org={org} /> : (
          <Gate
            title={`The composition couldn’t be loaded${failure ? marker(failure) : ''}`}
            action={(
              <>
                <Action variant="primary" onClick={content.reload}>Try again</Action>
                <Action to={compositionsPath(org)} variant="secondary">All compositions</Action>
              </>
            )}
          >
            The gateway didn’t answer for this composition. This says nothing about your access. Try again in a moment.
          </Gate>
        )}
      </CompositionFrame>
    );
  }
  return (
    <CompositionBody
      organization={organization}
      organizations={context.organizations}
      access={access}
      content={loaded}
      tab={tab}
      reload={content.reload}
    />
  );
}

/**
 * A composition (`composition-detail`, `/app/:org/compositions/:composition/:tab?`): its header, the version `?version=` names
 * (an id, a label or an ordinal; the latest when none, or when the one named is not listed) and its tabs. Any other tab is a
 * page that does not exist.
 */
export function CompositionDetail() {
  const { tab } = useParams();
  if (tab !== undefined && !isCompositionTabSegment(tab)) return <NotFoundScreen />;
  return <CompositionPage tab={tab} />;
}
