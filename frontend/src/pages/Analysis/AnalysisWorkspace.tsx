import { useState, type ReactNode } from 'react';
import { CircleDashed } from 'lucide-react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { analysisApi, decisionReceipt, type ArchiveQuery, type DecisionReceipt } from '../../analysis/archive';
import { platformApi } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { useResource } from '../../utils/useResource';
import { saveBytes } from '../Project/download';
import { Inspector } from './Inspector';
import { Priorities } from './Priorities';
import { Ranking, Recommendation } from './Ranking';
import { SaveReport } from './SaveReport';
import { SavedDecision } from './SavedDecision';
import { SpaceMap, BudgetsView, EvidenceView, FrontView, PreferencesView } from './Views';
import { analysisProblem } from './analysisErrors';
import { VIEWS, counted, evidenceKey, searchOfSources, targetOf, viewOf } from './analysisModel';
import { AnalysisFrame, Fact, ProblemNotice } from './parts';
import { useArchiveSession } from './useArchiveSession';
import { useStudyEvidence } from './useStudyEvidence';

const SOURCES = '/app/analysis';

type Export = 'receipt' | 'csv' | 'json';

function ChooseSources({ title, children }: { title: string; children: string }) {
  return (
    <EmptyState dashed icon={<CircleDashed />} title={title} action={<Action to={SOURCES} variant="primary">Choose sources</Action>}>{children}</EmptyState>
  );
}

/** The page title for the states that have no ranking yet (reading, refused, nothing chosen), so the screen always has its heading. */
function Waiting({ children }: { children: ReactNode }) {
  return (
    <AnalysisFrame trail={[{ label: 'Analysis', to: SOURCES }, { label: 'Decision space' }]}>
      <header className="proj-title-row">
        <div className="proj-title"><h1>Decision space</h1></div>
      </header>
      {children}
    </AnalysisFrame>
  );
}

function DecisionSpace({ initial, receipt, origin }: { initial: ArchiveQuery; receipt: DecisionReceipt | null; origin: string }) {
  const context = useOutletContext<PlatformOutletContext | null>();
  const [, setParams] = useSearchParams();
  const session = useArchiveSession(initial);
  const { query, data, detail, selected, problem, busy, effective } = session;
  /** The address offered to the dialog that saves the decision as a report; the dialog is open while there is one. */
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string; to?: string; link?: string } | null>(null);
  const view = viewOf(query.view ?? null);

  const pickView = (id: string) => {
    const next = viewOf(id);
    setParams((current) => { const copy = new URLSearchParams(current); copy.set('view', next); return copy; }, { replace: true });
    session.change({ view: next, page: 0, geometry: next === 'preferences' ? 'sensitivity' : 'none', viewport: null });
    setNotice(null);
  };
  const select = (id: string) => session.change({ selected: id });
  const shortlist = (id: string) => {
    const current = query.compare ?? [];
    if (current.includes(id)) session.change({ compare: current.filter((value) => value !== id) });
    else if (current.length < 4) session.change({ compare: [...current, id] });
    else setNotice({ tone: 'info', text: 'The shortlist holds four bindings. Remove one to add another.' });
  };
  const exportAs = async (format: Export) => {
    try {
      const text = format === 'receipt' ? JSON.stringify(await analysisApi.receipt(effective), null, 2) : await analysisApi.export(effective, format);
      saveBytes(new TextEncoder().encode(text).buffer as ArrayBuffer, format === 'receipt' ? 'binding-decision.json' : `binding-archive.${format}`, format === 'csv' ? 'text/csv' : 'application/json');
      setNotice({ tone: 'success', text: 'Export downloaded.' });
    } catch (caught) {
      session.fail(caught, 'export this analysis');
    }
  };

  const ready = Boolean(data) && !problem;
  const sources = data?.sources.length ?? query.sources.length;
  const sourceIds = data?.sources.map((source) => source.id) ?? query.sources;
  const changeSources = `${SOURCES}?${searchOfSources(sourceIds)}`;

  return (
    <AnalysisFrame trail={[{ label: 'Analysis', to: SOURCES }, { label: 'Decision space' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Decision space</h1>
          <p>
            {data
              ? `${sources} source${sources === 1 ? '' : 's'}${origin ? ` · ${origin}` : ''} · ${counted(data.counts.unique)} unique bindings, ${counted(data.counts.stored)} stored occurrences`
              : origin || 'Reading the stored results…'}
          </p>
        </div>
        <div className="proj-actions">
          {ready ? (
            <details className="an-export">
              <summary className="ui-action is-secondary is-md">Export</summary>
              <div className="an-export-menu">
                <Action variant="ghost" size="sm" onClick={() => void exportAs('receipt')}>Export receipt</Action>
                <Action variant="ghost" size="sm" onClick={() => void exportAs('csv')}>Export ranking CSV</Action>
                <Action variant="ghost" size="sm" onClick={() => void exportAs('json')}>Export archive JSON</Action>
              </div>
            </details>
          ) : <Action variant="secondary" disabled>Export</Action>}
          <Action variant="primary" disabled={!ready || busy} onClick={() => setSaving(`binding-decision-${Date.now().toString(36)}`)}>Save as report</Action>
        </div>
      </header>

      {problem && (
        <ProblemNotice
          problem={problem}
          action={problem.kind === 'missing' || problem.kind === 'key' || problem.kind === 'conflict'
            ? <Action to={changeSources} variant="secondary" size="sm">Change sources</Action>
            : <Action variant="secondary" size="sm" onClick={session.refresh}>{problem.kind === 'stale' ? 'Refresh' : 'Try again'}</Action>}
        />
      )}
      {problem && data && <Notice tone="info">The values below are the last response received, not trusted current evidence. Refresh before making a decision.</Notice>}
      {notice && (
        <Notice tone={notice.tone}>
          {notice.text}{notice.to && <> <Link to={notice.to}>{notice.link}</Link></>}
        </Notice>
      )}
      {receipt && (
        <details className="an-snapshot" open={Boolean(problem)}>
          <summary>Saved decision snapshot</summary>
          <p>This is the decision as it was recorded. Live analysis needs access to the matching sources.</p>
          <SavedDecision document={receipt} />
        </details>
      )}

      {!data && !problem && <div role="status" aria-busy="true"><span className="sr-only">Computing the ranking…</span><Skeleton variant="panel" /></div>}

      {data && (
        <>
          <div className="an-counts" aria-label="Evidence">
            <Fact label="Unique bindings">{counted(data.counts.unique)}</Fact>
            <Fact label="Stored occurrences">{counted(data.counts.stored)}</Fact>
            <Fact label="Eligible">{counted(data.counts.eligible)}</Fact>
            <Fact label="Hard-infeasible">{counted(data.counts.infeasible)}</Fact>
            <Fact label="Unknown feasibility">{counted(data.counts.unknown)}</Fact>
            <Fact label="Unexplored space">unknown</Fact>
          </div>

          <TabBar ariaLabel="Views" prefix="an" value={view} onChange={pickView} items={VIEWS.map((item) => ({ id: item.id, label: item.label }))} />
          <div className={`an-layout${busy ? ' is-busy' : ''}`} aria-busy={busy}>
            <Priorities data={data} query={query} change={session.change} />
            <TabPanel prefix="an" active={view}>
              <div className="an-main">
                {view === 'decision' && (
                  <>
                    <Recommendation data={data} select={select} compareWith={(winner, other) => session.change({ selected: other, compare: [winner] })} />
                    <Ranking data={data} query={query} selected={selected} busy={busy} select={select} shortlist={shortlist} change={session.change} />
                    <Inspector data={data} detail={detail} selected={selected} query={query} failed={Boolean(problem)} select={select} shortlist={shortlist} change={session.change} />
                    <SpaceMap data={data} query={effective} select={select} change={session.change} />
                  </>
                )}
                {view === 'budgets' && (
                  <>
                    <BudgetsView data={data} query={effective} select={select} change={session.change} />
                    <Inspector data={data} detail={detail} selected={selected} query={query} failed={Boolean(problem)} select={select} shortlist={shortlist} change={session.change} />
                  </>
                )}
                {view === 'pareto' && (
                  <>
                    <FrontView data={data} query={effective} select={select} change={session.change} selected={selected} session={session} />
                    <Inspector data={data} detail={detail} selected={selected} query={query} failed={Boolean(problem)} select={select} shortlist={shortlist} change={session.change} />
                  </>
                )}
                {view === 'preferences' && (
                  <>
                    <PreferencesView data={data} query={effective} select={select} change={session.change} />
                    <Inspector data={data} detail={detail} selected={selected} query={query} failed={Boolean(problem)} select={select} shortlist={shortlist} change={session.change} />
                  </>
                )}
                {view === 'evidence' && <EvidenceView data={data} />}
              </div>
            </TabPanel>
          </div>
          {busy && <p className="an-busy" role="status">Comparing stored bindings…</p>}
          <footer className="an-foot">
            {data.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            <small>{data.version} · archive {data.revision.replace(/^sha256[:-]/, '').slice(0, 10)}</small>
          </footer>
        </>
      )}

      {saving && data && (
        <SaveReport
          query={effective}
          defaultSlug={saving}
          organization={context?.organization?.slug}
          project={context?.project?.slug}
          close={() => setSaving(null)}
          saved={(path) => { setSaving(null); setNotice({ tone: 'success', text: 'Saved as a draft report with this exact receipt (priorities, rule, sources).', to: path, link: 'Open the draft' }); }}
        />
      )}
    </AnalysisFrame>
  );
}

/** The saved decision of a report (`?report=org/project/slug`), read before the space opens on its sources. */
function SavedSpace({ org, project, slug }: { org: string; project: string; slug: string }) {
  const saved = useResource(`saved-decision:${org}/${project}/${slug}`, () => platformApi.report(org, project, slug));
  if (saved.status === 'loading') return <Waiting><Skeleton variant="panel" /></Waiting>;
  const report = saved.data;
  const receipt = report ? decisionReceipt(report.document) : null;
  if (saved.status === 'error' || !report || !receipt) {
    return (
      <Waiting>
        {saved.status === 'error'
          ? <ProblemNotice problem={analysisProblem(saved.error, 'open the saved decision')} />
          : <Notice tone="error" title="This report doesn’t hold a decision">It has no valid binding-decision snapshot to reopen.</Notice>}
        <Action to={SOURCES} variant="secondary">Choose sources</Action>
      </Waiting>
    );
  }
  return <DecisionSpace initial={receipt.query} receipt={receipt} origin={`saved in ${report.title}`} />;
}

function WorkspaceScreen() {
  const [params] = useSearchParams();
  const target = targetOf(params);
  const study = useStudyEvidence(target.study);

  if (target.report) return <SavedSpace org={target.report.org} project={target.report.project} slug={target.report.slug} />;

  const fromStudy = target.jobs.length === 0 && target.study !== null;
  if (fromStudy && study.status === 'loading') {
    return <Waiting><div role="status" aria-busy="true"><span className="sr-only">Reading the study…</span><Skeleton variant="panel" /></div></Waiting>;
  }
  if (fromStudy && study.status === 'error') {
    return (
      <Waiting>
        <ProblemNotice problem={analysisProblem(study.error, 'read the study evidence')} />
        <Action to={SOURCES} variant="secondary">Choose sources</Action>
      </Waiting>
    );
  }
  const sources = target.jobs.length ? target.jobs : study.jobs;
  if (sources.length === 0) {
    return (
      <Waiting>
        <ChooseSources title="No sources chosen">Pick the finished runs to compare. A job, a study cell or a saved decision can open this page directly.</ChooseSources>
      </Waiting>
    );
  }
  const view = viewOf(params.get('view'));
  return <DecisionSpace initial={{ sources, view, rule: 'balanced', page: 0, compare: [], ...(view === 'preferences' ? { geometry: 'sensitivity' as const } : {}) }} receipt={null} origin={study.label} />;
}

/**
 * The decision space (`analysis-workspace`, `/app/analysis/workspace`): stored results ranked under the priorities and limits the person sets,
 * with the tools to read them — budgets, the trade-off front, preference switch points and the evidence. `?job=` (repeatable), `?study=&run=&cell=`
 * and `?report=org/project/slug` say what to open; `?view=` which view. A change of evidence rebuilds the space; a change of view does not.
 */
export function AnalysisWorkspace() {
  const [params] = useSearchParams();
  return <WorkspaceScreen key={evidenceKey(params)} />;
}
