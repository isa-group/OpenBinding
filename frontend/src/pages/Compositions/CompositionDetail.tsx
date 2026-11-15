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
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { Gate } from '../../features/workspace/parts';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { compositionPath, compositionsPath, isCompositionTabSegment, type CompositionTabSegment } from '../../routes/paths/compositions';
import { runPath } from '../../routes/paths/runs';
import { classifyAuthError, marker } from '../../shared/api/errors';
import type { CompositionVersionView } from '../../shared/api/types';
import { useResource } from '../../utils/useResource';
import { ReadOnlyNote } from '../Cases/parts';
import { CompositionMissing } from './CompositionMissing';
import { CompositionFrame } from './parts';
import { OverviewTab } from './tabs/OverviewTab';
import { relativeTime } from './time';
import { useRouteComposition, type CompositionAccess, type RouteCompositionContent } from './useRouteComposition';

type TabId = 'overview' | CompositionTabSegment;

/** The tabs built so far; Editor, Versions, Analysis and Settings join with their blocks. */
const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
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
  const [toast] = useState<string>(() => (location.state as { toast?: string } | null)?.toast ?? '');
  const picked = pickVersion(versions, query.get('version'));
  const shown = useResource<ShownVersion | null>(
    `composition-version:${org}/${composition.slug}/${picked?.id ?? 'none'}`,
    async () => {
      if (!picked) return null;
      const version = await compositionsApi.version(org, composition.slug, picked.id, { document: true });
      return findsInText(version) ? { version, content: await compositionsApi.content(org, composition.slug, version.id) } : { version };
    },
  );
  const open = (id: TabId, version = query.get('version') ?? undefined) => void navigate(
    compositionPath(org, composition.slug, id === 'overview' ? undefined : id, { version }), { viewTransition: true },
  );
  const updated = relativeTime(composition.updated_at);
  const version = shown.data?.version ?? null;
  const model = compositionViewModel({ composition, version, reader: 'member', content: shown.data?.content });
  const versionFailure = shown.status === 'error' ? classifyAuthError(shown.error) : null;
  const mine = (slug: string) => organizations.some((item) => item.slug === slug);

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
      </header>

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
        </div>
      )}
      {!canCreate && <ReadOnlyNote role={role}>You can read this composition and its versions. Sealing versions needs MEMBER.</ReadOnlyNote>}

      <TabBar items={TABS} value={active} onChange={(id) => open(id as TabId)} ariaLabel="Composition sections" prefix="cp-tab" />
      <TabPanel prefix="cp-tab" active={active}>
        {picked && shown.status === 'loading' && (
          <div role="status" aria-busy="true" className="cmp-panel-loading"><span className="sr-only">Loading the version…</span><Skeleton variant="panel" /><Skeleton variant="card" /></div>
        )}
        {versionFailure && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={() => { shown.reload(); reload(); }}>Retry</Action>}>
            {`Version ${picked?.label ?? ''} couldn’t be loaded${marker(versionFailure)}.`}
          </Notice>
        )}
        {active === 'overview' && (!picked || shown.status === 'ready') && <OverviewTab org={org} model={model} version={version} />}
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
