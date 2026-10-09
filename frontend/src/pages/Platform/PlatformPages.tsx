import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowRight, CheckCircle2, CircleDashed, CircleStop, Clock3, Copy, Eye, FileArchive, FileText, FlaskConical,
  Globe2, Layers3, LockKeyhole, Plus,
  RefreshCw, Sparkles, Trash2, TriangleAlert,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { platformApi } from '../../api/platform';
import { apiClient, bimResourceKey } from '../../api/client';
import type { EngineCatalogEntry } from '../../api/client';
import type {
  Analytics, BindingCase, CaseRevision, Publication, Report, Study, StudyCell, StudyRun,
} from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { EntityDrawer } from '../../components/Inspection/EntityDrawer';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { parseBindingSpace, toSuperscript } from '../../components/BindingSpaceBadge/bindingSpace';
import '../../components/Inspection/VisualEffects.css';
import './PlatformPages.css';

function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="observatory-empty"><CircleDashed aria-hidden="true" /><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function PageHeading({ eyebrow, title, detail, action }: {
  eyebrow: string; title: string; detail: string; action?: ReactNode;
}) {
  return <header className="platform-page-heading"><div><span>{eyebrow}</span><h1>{title}</h1><p>{detail}</p></div>{action}</header>;
}

// The Home (app-home), the organization screens (org-*), the project screens (proj-*), the case screens (case-*, snap-detail) and the
// files, resources and collections live in pages/AppHome, pages/Organization, pages/Project, pages/Cases and pages/Resources (their styles
// are in pages/Platform/{CaseDetailPage,SnapshotPage}.css). What stays here are the pages of studies, analytics and reports that have not been migrated yet.

/** What the pages of a project show when the workspace has no project to open: the way to the new-project screen. */
function NoProject() {
  const context = useOutletContext<PlatformOutletContext>();
  if (context.loading) return <div className="route-loading" role="status"><span className="status-dot" aria-hidden="true" /> Loading workspace…</div>;
  if (!context.organization) return <div className="platform-page"><Empty title="No organization yet" detail="Create an organization from the activity page first." /></div>;
  return <div className="platform-page"><PageHeading eyebrow={context.organization.name} title="Create a first project" detail="Projects isolate cases, studies, artifacts and permissions." action={<Link className="platform-primary-action" to={`/app/${context.organization.slug}/new-project`}><Plus aria-hidden="true" />New project</Link>} /></div>;
}

export function StudiesPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [studies, setStudies] = useState<Study[]>([]);
  const [runs, setRuns] = useState<Record<string, StudyRun[]>>({});
  const [runCells, setRunCells] = useState<Record<string, StudyCell[]>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [cases, setCases] = useState<BindingCase[]>([]);
  const [caseRevisions, setCaseRevisions] = useState<Record<string, CaseRevision[]>>({});
  const [engines, setEngines] = useState<EngineCatalogEntry[]>([]);
  const [selectedRevisions, setSelectedRevisions] = useState<string[]>([]);
  const [selectedEngines, setSelectedEngines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [inspectStudy, setInspectStudy] = useState<Study | null>(null);
  const [libraryDefinition, setLibraryDefinition] = useState('');
  const [libraryCollection, setLibraryCollection] = useState('');

  const load = useCallback(async () => {
    if (!organization || !project) return;
    const [next, nextCases, nextEngines] = await Promise.all([
      platformApi.studies(organization.slug, project.slug, true),
      platformApi.cases(organization.slug, project.slug),
      apiClient.getEngines(),
    ]);
    setStudies(next); setCases(nextCases); setEngines(nextEngines);
    setCaseRevisions(Object.fromEntries(await Promise.all(nextCases.map(async (item) => [item.id, await platformApi.revisions(organization.slug, project.slug, item.slug)]))));
    const nextRuns = Object.fromEntries(await Promise.all(next.map(async (study) => [study.id, await platformApi.studyRuns(organization.slug, project.slug, study.slug)])));
    setRuns(nextRuns);
    setRunCells(Object.fromEntries(await Promise.all(next.flatMap((study) => {
      const latest = nextRuns[study.id]?.[0];
      return latest ? [[latest.id, platformApi.studyCells(organization.slug, project.slug, study.slug, latest.id)]] : [];
    }).map(async ([runId, request]) => [runId, await request]))));
  }, [organization, project]);
  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Studies could not be loaded.')); }, [load]);
  if (!organization || !project) return <NoProject />;
  const execute = async (study: Study) => {
    setRunning(study.id); setError(null);
    try { await platformApi.runStudy(organization.slug, project.slug, study.slug, study.definition_version_id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Study dispatch failed.'); }
    finally { setRunning(null); }
  };
  const cancel = async (study: Study, run: StudyRun) => {
    setRunning(`cancel:${run.id}`); setError(null);
    try { await platformApi.cancelStudyRun(organization.slug, project.slug, study.slug, run.id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Study cancellation failed.'); }
    finally { setRunning(null); }
  };
  const retry = async (study: Study, run: StudyRun, cell: StudyCell) => {
    setRunning(`retry:${cell.id}`); setError(null);
    try { await platformApi.retryStudyCell(organization.slug, project.slug, study.slug, run.id, cell.id); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Cell retry failed.'); }
    finally { setRunning(null); }
  };
  const engineChoices = engines.flatMap((engine) => engine.modes.map((mode) => ({ engine, mode, key: `${bimResourceKey(engine.ref)}#${mode.id}` })));
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null);
    const form = new FormData(event.currentTarget);
    try {
      if (!selectedRevisions.length && !libraryCollection) throw new Error('Choose executable case revisions or a sealed collection.');
      if (!selectedEngines.length) throw new Error('Choose at least one exact Engine mode.');
      const parameterSets = JSON.parse(String(form.get('parameters') || '[{}]')) as Array<Record<string, unknown>>;
      if (!Array.isArray(parameterSets) || !parameterSets.length) throw new Error('Parameter sets must be a non-empty JSON array.');
      const seeds = String(form.get('seeds') || '0').split(',').map((seed) => Number(seed.trim()));
      if (!seeds.length || seeds.some((seed) => !Number.isSafeInteger(seed))) throw new Error('Seeds must be comma-separated integers.');
      await platformApi.createStudy(organization.slug, project.slug, {
        slug: String(form.get('slug')), name: String(form.get('name')),
        description: String(form.get('description') || ''),
        definition: {
          case_revision_ids: selectedRevisions,
          ...(libraryCollection ? { collection_version_id: libraryCollection } : {}),
          engines: engineChoices.filter((choice) => selectedEngines.includes(choice.key)).map(({ engine, mode }) => ({ ...engine.ref, mode: mode.id })),
          parameter_sets: parameterSets,
          seeds,
        },
      });
      event.currentTarget.reset(); setSelectedRevisions([]); setSelectedEngines([]); setLibraryCollection(''); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Study creation failed.'); }
  };
  return (
    <div className="platform-page">
      <PageHeading eyebrow="Reproducible experiments" title="Comparative studies" detail="Each run freezes the Cartesian matrix of case revisions, engine revisions, parameter sets and seeds before dispatch." />
      {error && <p className="platform-form-error" role="alert">{error}</p>}
      <div className="study-list">
        {studies.map((study) => {
          const latest = runs[study.id]?.[0]; const cells = study.definition.case_revision_ids.length * study.definition.engines.length * study.definition.parameter_sets.length * study.definition.seeds.length;
          const retryable = latest ? (runCells[latest.id] ?? []).filter((cell) => cell.state === 'failed' || cell.state === 'cancelled') : [];
          return (
            <article key={study.id}>
              <div className="study-index">
                <FlaskConical aria-hidden="true" />
                <span>{cells}<small>cells</small></span>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <span className="status-chip">{study.archived ? 'archived' : study.state}</span>
                  <button
                    type="button"
                    onClick={() => setInspectStudy(study)}
                    className="hash-badge"
                    style={{ cursor: 'pointer', padding: '2px 6px' }}
                    title="Inspect & Edit Study"
                  >
                    <Eye size={12} /> Inspect
                  </button>
                </div>
                <h2>{study.name}</h2>
                <p>{study.description || 'Exact comparative matrix.'}</p>
                <Link to={`/app/${organization.slug}/library/${study.definition_artifact_id}/versions/${study.definition_version_id}`}>Open versioned definition</Link>
                {study.state === 'ready' && <details><summary>Select definition version</summary>
                  <ArtifactVersionPicker org={organization.slug} kind="Study" artifactId={study.definition_artifact_id} versionId={study.definition_version_id} onSelect={(_, version) => {
                    void platformApi.updateStudy(organization.slug, project.slug, study.slug, { definition_version_id: version.id })
                      .then(load).catch(caught => setError(String(caught)));
                  }} />
                </details>}

                <div className="study-formula">
                  <code>{study.definition.case_revision_ids.length} cases</code>
                  <b>×</b>
                  <code>{study.definition.engines.length} engines</code>
                  <b>×</b>
                  <code>{study.definition.parameter_sets.length} parameters</code>
                  <b>×</b>
                  <code>{study.definition.seeds.length} seeds</code>
                </div>
                {latest && retryable.length > 0 && (
                  <details className="study-retries">
                    <summary>{retryable.length} retryable cell{retryable.length === 1 ? '' : 's'}</summary>
                    <div>
                      {retryable.map((cell) => (
                        <button key={cell.id} type="button" disabled={running !== null} onClick={() => void retry(study, latest, cell)}>
                          <RefreshCw aria-hidden="true" /> Cell {cell.ordinal + 1} · {running === `retry:${cell.id}` ? 'retrying…' : cell.state}
                        </button>
                      ))}
                    </div>
                  </details>
                )}
              </div>
              <aside>
                {latest ? (
                  <>
                    <small>Latest run #{latest.run_number}</small>
                    <strong className={`run-state is-${latest.state}`}>{latest.state}</strong>
                    <Link to={`/app/${organization.slug}/${project.slug}/analytics`}>
                      Inspect analysis <ArrowRight aria-hidden="true" />
                    </Link>
                    {(latest.state === 'queued' || latest.state === 'running') && (
                      <button className="study-cancel" type="button" onClick={() => void cancel(study, latest)} disabled={running !== null}>
                        <CircleStop aria-hidden="true" />{running === `cancel:${latest.id}` ? 'Cancelling…' : 'Cancel run'}
                      </button>
                    )}
                  </>
                ) : (
                  <small>Never run</small>
                )}
                <button type="button" onClick={() => {
                  void platformApi.updateStudy(organization.slug, project.slug, study.slug, { archived: !study.archived })
                    .then(load).catch(caught => setError(String(caught)));
                }}>{study.archived ? 'Restore study' : 'Archive study'}</button>
                <button type="button" onClick={() => void execute(study)} disabled={running !== null || study.archived || study.state !== 'ready'}>
                  <RefreshCw aria-hidden="true" />{running === study.id ? 'Dispatching…' : 'Run matrix'}
                </button>
              </aside>
            </article>
          );
        })}
      </div>
      {!studies.length && <Empty title="No study definitions" detail="Create a study from a case after choosing exact compatible engine revisions and seeds." action={<Link to={`/app/${organization.slug}/${project.slug}/cases`}>Choose a case</Link>} />}
      <details className="study-builder"><summary>Use a library study definition</summary>
        <form onSubmit={async event => {
          event.preventDefault(); const element = event.currentTarget; const data = new FormData(element);
          try {
            await platformApi.createStudy(organization.slug, project.slug, {
              name: String(data.get('name')), slug: String(data.get('slug')), description: '', definition_version_id: libraryDefinition,
            });
            element.reset(); setLibraryDefinition(''); await load();
          } catch (caught) { setError(String(caught)); }
        }}>
          <label>Name<input name="name" required /></label>
          <label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
          <ArtifactVersionPicker org={organization.slug} kind="Study" versionId={libraryDefinition} onSelect={(_, version) => setLibraryDefinition(version.id)} />
          <button disabled={!libraryDefinition}>Use selected version</button>
        </form>
      </details>
      <details className="study-builder"><summary><Plus aria-hidden="true" /> Define comparative study</summary><form onSubmit={create}><div className="study-builder-fields"><label>Name<input name="name" required /></label><label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Description<textarea name="description" rows={3} /></label></div><fieldset><legend>Library collection (optional)</legend><ArtifactVersionPicker org={organization.slug} kind="Collection" versionId={libraryCollection} onSelect={(_, version) => setLibraryCollection(version.id)} />{libraryCollection && <button type="button" onClick={() => setLibraryCollection('')}>Clear collection</button>}<p>All case members of this exact version are included with the cases selected below.</p></fieldset><div className="study-builder-matrix"><fieldset><legend>Executable case revisions</legend>{cases.flatMap((item) => (caseRevisions[item.id] || []).filter(revision => revision.source_snapshot_id).map(revision => <label key={revision.id}><input type="checkbox" disabled={!revision} checked={Boolean(revision && selectedRevisions.includes(revision.id))} onChange={() => revision && setSelectedRevisions((current) => current.includes(revision.id) ? current.filter((id) => id !== revision.id) : [...current, revision.id])} /><span><strong>{item.name}</strong><small>{revision ? `r${revision.revision} · ${revision.digest.slice(0, 15)}…` : 'Attach a revision backed by a BIM snapshot first'}</small></span></label>))}{!cases.length && <p>No binding cases yet.</p>}</fieldset><fieldset><legend>Exact Engine modes</legend>{engineChoices.map(({ engine, mode, key }) => <label key={key}><input type="checkbox" checked={selectedEngines.includes(key)} onChange={() => setSelectedEngines((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} /><span><strong>{engine.namespace}/{engine.name}</strong><small>{engine.version} · {mode.id} · {engine.digest.slice(0, 12)}…</small></span></label>)}{!engineChoices.length && <p>No compatible engines visible.</p>}</fieldset></div><div className="study-builder-options"><label>Parameter sets (JSON array)<textarea name="parameters" rows={5} defaultValue="[{}]" spellCheck={false} /></label><label>Seeds<input name="seeds" defaultValue="0" placeholder="0, 1, 2" /></label><output>{selectedRevisions.length || 0} × {selectedEngines.length || 0} × parameters × seeds</output><button>Create immutable definition</button></div></form></details>

      {/* Slide-over Drawer for Study */}
      {inspectStudy && (
        <EntityDrawer
          isOpen={Boolean(inspectStudy)}
          onClose={() => setInspectStudy(null)}
          title={inspectStudy.name}
          subtitle={`Study Slug: ${inspectStudy.slug} · State: ${inspectStudy.state}`}
          badge={{ label: inspectStudy.state.toUpperCase(), variant: 'default' }}
          metadata={[
            { label: 'Slug', value: inspectStudy.slug },
            { label: 'Name', value: inspectStudy.name },
            { label: 'State', value: inspectStudy.state },
            { label: 'Created At', value: new Date(inspectStudy.created_at).toLocaleString() },
            { label: 'Description', value: inspectStudy.description || 'None' },
            { label: 'Cases in Matrix', value: String(inspectStudy.definition.case_revision_ids.length) },
            { label: 'Engines', value: inspectStudy.definition.engines.map((e) => `${e.namespace}/${e.name}`).join(', ') },
            { label: 'Seeds', value: inspectStudy.definition.seeds.join(', ') },
          ]}
          editable={{
            fields: [
              { key: 'name', label: 'Study Name', initialValue: inspectStudy.name },
              { key: 'description', label: 'Description', type: 'textarea', initialValue: inspectStudy.description || '' },
            ],
            onSave: async (vals) => {
              await platformApi.updateStudy(organization.slug, project.slug, inspectStudy.slug, {
                name: vals.name,
                description: vals.description,
              });
              await load();
            },
          }}
          deletable={{
            confirmMessage: `Permanently delete comparative study "${inspectStudy.name}" and all associated runs/cells?`,
            onDelete: async () => {
              await platformApi.deleteStudy(organization.slug, project.slug, inspectStudy.slug);
              await load();
            },
          }}
          jsonDocument={inspectStudy.definition as unknown as Record<string, unknown>}
        />
      )}
    </div>
  );
}

export function AnalyticsPage() {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [studies, setStudies] = useState<Study[]>([]);
  const [selection, setSelection] = useState<{ study: Study; run: StudyRun } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [cells, setCells] = useState<StudyCell[]>([]);
  const [inspectCell, setInspectCell] = useState<StudyCell | null>(null);
  useEffect(() => {
    if (!organization || !project) return;
    void platformApi.studies(organization.slug, project.slug).then(async (next) => {
      setStudies(next);
      for (const study of next) {
        const runs = await platformApi.studyRuns(organization.slug, project.slug, study.slug);
        if (runs[0]) { setSelection({ study, run: runs[0] }); return; }
      }
    });
  }, [organization, project]);
  useEffect(() => {
    if (!organization || !project || !selection) return;
    void Promise.all([
      platformApi.analytics(organization.slug, project.slug, selection.study.slug, selection.run.id),
      platformApi.studyCells(organization.slug, project.slug, selection.study.slug, selection.run.id),
    ]).then(([nextAnalytics, nextCells]) => { setAnalytics(nextAnalytics); setCells(nextCells); });
  }, [organization, project, selection]);
  const [analysisJob, setAnalysisJob] = useState<string>('');
  // The outcome remembers which job it belongs to, so choosing another job reads as "loading" without
  // resetting any state from inside the effect.
  const [analysisOutcome, setAnalysisOutcome] = useState<{ job: string; result: unknown; error: string } | null>(null);
  const availableCells = cells.filter(cell => cell.job_id);
  const effectiveJob = availableCells.some(cell => cell.job_id === analysisJob) ? analysisJob : availableCells[0]?.job_id ?? '';
  const currentOutcome = effectiveJob && analysisOutcome?.job === effectiveJob ? analysisOutcome : null;
  const analysisResult = currentOutcome?.result ?? null;
  const analysisError = currentOutcome?.error ?? '';
  useEffect(() => {
    if (!effectiveJob) return undefined;
    let active = true;
    void apiClient.getJobStatus(effectiveJob).then(job => {
      if (active) setAnalysisOutcome({ job: effectiveJob, result: job.result, error: '' });
    }).catch(error => {
      if (active) setAnalysisOutcome({ job: effectiveJob, result: null, error: error instanceof Error ? error.message : 'Unable to load job' });
    });
    return () => { active = false; };
  }, [effectiveJob]);
  if (!organization || !project) return <NoProject />;
  return <div className="platform-page analysis-page"><PageHeading eyebrow="Evidence, not decoration" title="Binding analysis" detail="Inspect feasibility, objective trade-offs, timing and stability while retaining the cell fingerprints behind every point." action={studies.length > 1 ? <select aria-label="Study run" value={selection?.study.id ?? ''} onChange={(event) => { const study = studies.find((item) => item.id === event.target.value); if (study) void platformApi.studyRuns(organization.slug, project.slug, study.slug).then((runs) => runs[0] && setSelection({ study, run: runs[0] })); }}>{studies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : undefined} />
    {!analytics ? <Empty title="No completed study to analyze" detail="Run a comparative study; this surface will derive its charts from the persisted cell metrics." /> : <>
      <div className="analysis-kpis">
        <article><CheckCircle2 /><small>Feasible</small><strong>{analytics.feasible}</strong><span>of {analytics.cells} cells</span></article>
        <article><TriangleAlert /><small>Failed</small><strong>{analytics.failed}</strong><span>retryable cells</span></article>
        <article><Clock3 /><small>Median runtime</small><strong>{analytics.runtimes_s.length ? `${analytics.runtimes_s[Math.floor(analytics.runtimes_s.length / 2)].toFixed(2)}s` : '—'}</strong><span>end-to-end</span></article>
        <article><Sparkles /><small>Analysis scope</small><strong>One job</strong><span>comparable canonical solutions</span></article>
        {analytics.binding_space && (
          <article>
            <Layers3 />
            <small>Binding space</small>
            <strong>{parseBindingSpace(analytics.binding_space.cardinality).formatted}</strong>
            <span>10{toSuperscript(Math.round(analytics.binding_space.log10))} combinations ({analytics.binding_space.tasks} tasks)</span>
          </article>
        )}
      </div>
      <div className="analysis-grid">
        {analytics.binding_space && (
          <article className="analysis-panel binding-space-panel">
            <header>
              <div>
                <span>Combinatorial Complexity</span>
                <h2>{(analytics.binding_space.cases?.length ?? 0) > 1 ? 'Largest instance search space' : 'Instance search space'}</h2>
              </div>
              <small>
                {(analytics.binding_space.cases?.length ?? 0) > 1 ? `${analytics.binding_space.cases!.length} cases · largest cardinality` : analytics.binding_space.case_name ? `${analytics.binding_space.case_name} · rev ${analytics.binding_space.revision}` : 'Analyzed instance'}
              </small>
            </header>
            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <BindingSpaceBadge
                cardinality={analytics.binding_space.cardinality}
                breakdown={analytics.binding_space.breakdown}
                variant="card"
              />
              {analytics.binding_space.cases && analytics.binding_space.cases.length > 1 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Cases complexity breakdown
                  </span>
                  {analytics.binding_space.cases.map((c) => (
                    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.85rem', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                      <div>
                        <strong>{c.name}</strong>
                        <small style={{ display: 'block', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>rev {c.revision} · {c.tasks} tasks</small>
                      </div>
                      <BindingSpaceBadge cardinality={c.cardinality} breakdown={c.breakdown} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </article>
        )}
        <article className="analysis-panel pareto-panel" style={{ gridColumn: '1 / -1' }}><header><div><span>Canonical solution analysis</span><h2>Explore a study cell</h2></div></header><label>Study cell<select aria-label="Analysis study cell" value={effectiveJob} onChange={event => setAnalysisJob(event.target.value)}>{availableCells.map(cell => <option key={cell.id} value={cell.job_id!}>Cell {cell.ordinal + 1} · {String(cell.parameters.analysisScenario ?? cell.metrics.analysisScenario ?? cell.engine_ref.name)} · seed {cell.seed} · {cell.binding_case_revision_id}</option>)}</select></label><p>Choose one execution to preserve instance, objective and normalization semantics. Different cases are never pooled into one Pareto front.</p>{analysisError ? <p role="alert">{analysisError}</p> : effectiveJob && !analysisResult ? <p>Loading canonical result…</p> : <BindingAnalysis result={analysisResult} jobId={effectiveJob || undefined} />}</article>
        <article className="analysis-panel"><header><div><span>Runtime distribution</span><h2>Cost of evidence</h2></div></header><div className="chart-frame"><ResponsiveContainer width="100%" height="100%"><BarChart data={analytics.runtimes_s.map((value, index) => ({ cell: index + 1, seconds: value }))}><CartesianGrid stroke="var(--color-border)" vertical={false}/><XAxis dataKey="cell" hide/><YAxis stroke="var(--color-text-tertiary)"/><Tooltip/><Bar dataKey="seconds" fill="var(--color-dialect)" radius={[2,2,0,0]}/></BarChart></ResponsiveContainer></div></article>
        <article className="analysis-panel"><header><div><span>Stability between seeds</span><h2>Repeatability</h2></div></header><div className="stability-ledger">{Object.entries(analytics.stability).map(([engine, value]) => <div key={engine}><span>{engine}</span><meter min="0" max="1" value={value.repeatability}>{value.repeatability}</meter><strong>{Math.round(value.repeatability * 100)}%</strong><small>{value.distinct}/{value.samples} distinct</small></div>)}{!Object.keys(analytics.stability).length && <p>No repeated objective samples yet.</p>}</div></article>
      </div>
      <section className="cell-ledger">
        <header>
          <div><span>Provenance ledger</span><h2>Every plotted cell</h2></div>
          <small>{selection?.run.matrix_digest.slice(0, 24)}…</small>
        </header>
        <div>
          {cells.map((cell) => (
            <article
              key={cell.id}
              style={{ cursor: 'pointer' }}
              onClick={() => setInspectCell(cell)}
              title="Click to inspect study cell execution and objectives"
            >
              <span>{String(cell.ordinal + 1).padStart(3, '0')}</span>
              <strong>{cell.engine_ref.name}<small>{cell.engine_ref.mode ?? cell.engine_ref.version}</small></strong>
              <code>seed {cell.seed}</code>
              <span className={`run-state is-${cell.state}`}>{cell.state}</span>
              <button
                type="button"
                className="hash-badge"
                style={{ padding: '2px 6px', cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setInspectCell(cell);
                }}
                title="Inspect cell details"
              >
                <Eye size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                title="Copy fingerprint"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard.writeText(cell.fingerprint);
                }}
              >
                <Copy aria-hidden="true" />
              </button>
            </article>
          ))}
        </div>
      </section>

      {/* Slide-over Drawer for Study Cell */}
      {inspectCell && (
        <EntityDrawer
          isOpen={Boolean(inspectCell)}
          onClose={() => setInspectCell(null)}
          title={`Study Cell #${inspectCell.ordinal + 1} · ${inspectCell.engine_ref.name}`}
          subtitle={`Fingerprint: ${inspectCell.fingerprint}`}
          badge={{
            label: inspectCell.state.toUpperCase(),
            variant: inspectCell.state === 'completed' ? 'completed' : inspectCell.state === 'failed' ? 'failed' : 'running',
          }}
          metadata={[
            { label: 'Ordinal', value: `#${inspectCell.ordinal + 1}` },
            { label: 'State', value: inspectCell.state },
            { label: 'Engine', value: `${inspectCell.engine_ref.namespace}/${inspectCell.engine_ref.name}` },
            { label: 'Version / Mode', value: `${inspectCell.engine_ref.version} (${inspectCell.engine_ref.mode ?? 'default'})` },
            { label: 'Seed', value: String(inspectCell.seed) },
            { label: 'Runtime', value: typeof inspectCell.metrics?.runtime_s === 'number' ? `${(inspectCell.metrics.runtime_s as number).toFixed(3)}s` : '—' },
            { label: 'Fingerprint', value: <code className="hash-badge" title={inspectCell.fingerprint}>{inspectCell.fingerprint.slice(0, 24)}…</code> },
          ]}
          jsonDocument={{
            id: inspectCell.id,
            study_run_id: inspectCell.study_run_id,
            ordinal: inspectCell.ordinal,
            state: inspectCell.state,
            engine: inspectCell.engine_ref,
            seed: inspectCell.seed,
            parameters: inspectCell.parameters,
            metrics: inspectCell.metrics,
            fingerprint: inspectCell.fingerprint,
          }}
        />
      )}
    </>}
  </div>;
}

// The project files (`proj-files`) live in pages/Resources; this is the list of reports until the task that rebuilds it replaces it.
export function ProjectRecordsPage({ kind }: { kind: 'reports' }) {
  const { organization, project } = useOutletContext<PlatformOutletContext>();
  const [reports, setReports] = useState<Report[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [runOptions, setRunOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [inspectReport, setInspectReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!organization || !project) return;
    setLoading(true);
    try {
      const [nextReports, nextStudies, nextPublications] = await Promise.all([
        platformApi.reports(organization.slug, project.slug),
        platformApi.studies(organization.slug, project.slug, true),
        platformApi.publications(organization.slug, project.slug),
      ]);
      setReports(nextReports);
      setPublications(nextPublications);
      const nested = await Promise.all(
        nextStudies.map(async (study) =>
          (await platformApi.studyRuns(organization.slug, project.slug, study.slug)).map((run) => ({
            id: run.id,
            label: `${study.name} · run ${run.run_number} · ${run.state}`,
          }))
        )
      );
      setRunOptions(nested.flat());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `The ${kind} could not be loaded.`);
    } finally {
      setLoading(false);
    }
  }, [organization, project, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!organization || !project) return <NoProject />;

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setBusy('create');
    try {
      const document = JSON.parse(String(form.get('document'))) as Record<string, unknown>;
      await platformApi.createReport(organization.slug, project.slug, {
        title: String(form.get('title')),
        slug: String(form.get('slug')),
        study_run_id: String(form.get('run') || '') || null,
        document,
      });
      event.currentTarget.reset();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report creation failed.');
    } finally {
      setBusy(null);
    }
  };

  const freeze = async (report: Report) => {
    setBusy(report.id);
    setError(null);
    try {
      await platformApi.freezeReport(organization.slug, project.slug, report.slug);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report could not be frozen.');
    } finally {
      setBusy(null);
    }
  };

  const publish = async (report: Report) => {
    setBusy(report.id);
    setError(null);
    try {
      await platformApi.publishReport(organization.slug, project.slug, {
        report_id: report.id,
        slug: report.slug,
        citation: { title: report.title, digest: report.digest },
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Report could not be published.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="platform-page">
      <PageHeading
        eyebrow="Reproducibility"
        title="Reports"
        detail="Freeze a human-readable analysis with exact BIM, engine, dataset and parameter provenance."
      />
      {error && <p className="platform-form-error" role="alert">{error}</p>}

      {loading && <p className="record-loading" role="status">Reading {kind}…</p>}

      <div className="record-ledger">
        {reports.map((item) => {
              const publication = publications.find((candidate) => candidate.report_id === item.id);
              return (
                <article
                  key={item.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setInspectReport(item)}
                  title="Click to inspect report document and provenance"
                >
                  <FileArchive />
                  <div>
                    <span className={`hash-badge ${item.state === 'frozen' ? 'glow-completed' : 'glow-running'}`}>
                      {publication ? 'published' : item.state}
                    </span>
                    <h2>
                      <Link
                        to={`/app/${organization.slug}/${project.slug}/reports/${item.slug}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                        onClick={(e) => e.stopPropagation()}
                        title="Open full dedicated report view"
                      >
                        {item.title}
                      </Link>
                    </h2>
                    <code>{item.digest ? `${item.digest.slice(0, 24)}…` : 'Unfrozen draft'}</code>
                  </div>
                  <small>{new Date(item.created_at).toLocaleDateString()}</small>
                  <div className="record-actions" onClick={(e) => e.stopPropagation()}>
                    <Link
                      to={`/app/${organization.slug}/${project.slug}/reports/${item.slug}`}
                      className="hash-badge"
                      style={{ textDecoration: 'none', padding: '4px 8px', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                      title="Open dedicated full page report view"
                    >
                      <FileText size={12} /> Full View
                    </Link>
                    <button
                      type="button"
                      onClick={() => setInspectReport(item)}
                      title="Inspect details and document"
                    >
                      <Eye size={13} aria-hidden="true" /> Inspect
                    </button>
                    {item.state === 'draft' && (
                      <button disabled={busy === item.id} onClick={() => void freeze(item)}>
                        <LockKeyhole size={13} aria-hidden="true" /> Freeze
                      </button>
                    )}
                    {item.state === 'frozen' && !publication && (
                      <button disabled={busy === item.id} onClick={() => void publish(item)}>
                        <Globe2 aria-hidden="true" /> Publish
                      </button>
                    )}
                    {publication && (
                      <span className="hash-badge" style={{ color: 'var(--color-accent)' }}>
                        <Globe2 aria-hidden="true" size={13} /> /{publication.slug}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
      </div>

      {!loading && !reports.length && (
        <Empty title="No reports yet" detail="Create a report from a study run, then freeze it before publication." />
      )}

      <details className="report-builder">
        <summary>
          <Plus aria-hidden="true" /> Draft report
        </summary>
        <form onSubmit={create}>
          <label>
            Title
            <input name="title" required />
          </label>
          <label>
            Slug
            <input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
          </label>
          <label>
            Study run
            <select name="run" defaultValue="">
              <option value="">No run pinned</option>
              {runOptions.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.label}
                </option>
              ))}
            </select>
          </label>
          <label className="report-document">
            Report document (JSON)
            <textarea
              name="document"
              rows={8}
              required
              spellCheck={false}
              defaultValue={'{\n  "summary": "",\n  "findings": [],\n  "provenance": {}\n}'}
            />
          </label>
          <button disabled={busy === 'create'}>
            {busy === 'create' ? 'Creating…' : 'Create draft'}
          </button>
        </form>
      </details>

      {/* Slide-over Drawer for Report */}
      {inspectReport && (() => {
        const pub = publications.find((c) => c.report_id === inspectReport.id);
        const isDraft = inspectReport.state === 'draft';
        const actionsList: Array<{
          label: string;
          icon?: ReactNode;
          onClick: () => Promise<void>;
          variant?: 'primary' | 'secondary' | 'danger';
          disabled?: boolean;
          title?: string;
        }> = [];

        if (isDraft) {
          actionsList.push({
            label: busy === inspectReport.id ? 'Freezing…' : 'Freeze Report',
            icon: <LockKeyhole size={13} />,
            variant: 'primary',
            disabled: busy === inspectReport.id,
            title: 'Freeze report with exact immutable provenance',
            onClick: async () => {
              await freeze(inspectReport);
              setInspectReport(null);
            },
          });
        } else if (!pub) {
          actionsList.push({
            label: busy === inspectReport.id ? 'Publishing…' : 'Publish Report',
            icon: <Globe2 size={13} />,
            variant: 'primary',
            disabled: busy === inspectReport.id,
            title: 'Publish frozen report to public ledger',
            onClick: async () => {
              await publish(inspectReport);
              setInspectReport(null);
            },
          });
        }

        if (pub) {
          actionsList.push({
            label: 'Delete Publication',
            icon: <Trash2 size={13} />,
            variant: 'danger',
            title: 'Remove public publication link for this report',
            onClick: async () => {
              if (window.confirm(`Permanently unpublish / delete publication "${pub.slug}"?`)) {
                await platformApi.deletePublication(organization.slug, project.slug, pub.slug);
                await load();
                setInspectReport(null);
              }
            },
          });
        }

        return (
          <EntityDrawer
            isOpen={Boolean(inspectReport)}
            onClose={() => setInspectReport(null)}
            title={inspectReport.title}
            subtitle={`Report Slug: ${inspectReport.slug}`}
            fullPageUrl={`/app/${organization.slug}/${project.slug}/reports/${inspectReport.slug}`}
            badge={{
              label: pub ? 'PUBLISHED' : inspectReport.state.toUpperCase(),
              variant: inspectReport.state === 'frozen' ? 'completed' : 'running',
            }}
            metadata={[
              { label: 'Slug', value: inspectReport.slug },
              { label: 'Title', value: inspectReport.title },
              { label: 'State', value: pub ? 'Published' : inspectReport.state },
              {
                label: 'Digest',
                value: inspectReport.digest ? (
                  <code className="hash-badge" title={inspectReport.digest}>
                    {inspectReport.digest.slice(0, 20)}…
                  </code>
                ) : (
                  'Draft (unfrozen)'
                ),
              },
              { label: 'Pinned Study Run', value: inspectReport.study_run_id || 'None pinned' },
              { label: 'Created At', value: new Date(inspectReport.created_at).toLocaleString() },
              ...(pub
                ? [
                    { label: 'Publication Slug', value: `/${pub.slug}` },
                    { label: 'Publication DOI', value: (pub.citation?.doi as string | undefined) || 'None' },
                  ]
                : []),
            ]}
            jsonDocument={inspectReport.document}
            editable={
              isDraft
                ? {
                    fields: [
                      { key: 'title', label: 'Report Title', initialValue: inspectReport.title },
                      {
                        key: 'document',
                        label: 'Report Document (JSON)',
                        type: 'textarea',
                        initialValue: JSON.stringify(inspectReport.document, null, 2),
                      },
                    ],
                    onSave: async (vals) => {
                      await platformApi.updateReport(organization.slug, project.slug, inspectReport.slug, {
                        title: vals.title,
                        document: JSON.parse(vals.document) as Record<string, unknown>,
                      });
                      await load();
                    },
                  }
                : undefined
            }
            deletable={{
              confirmMessage: `Permanently delete report "${inspectReport.title}"?`,
              onDelete: async () => {
                await platformApi.deleteReport(organization.slug, project.slug, inspectReport.slug);
                await load();
              },
            }}
            actions={actionsList}
          />
        );
      })()}
    </div>
  );
}
