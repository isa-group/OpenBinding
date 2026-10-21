import { useEffect, useRef, useState } from 'react';
import {
  analysisApi, type AnalysisTask, type ArchiveQuery, type ArchiveResponse, type CandidateDetail,
} from '../../analysis/archive';
import { analysisProblem, type AnalysisProblem } from './analysisErrors';

export interface ArchiveSession {
  query: ArchiveQuery;
  /** The query as the gateway should read it: with the binding in focus and the revision it was computed from. */
  effective: ArchiveQuery;
  /** The last answer. It stays on screen while a new one is computed, or when the gateway refuses the next. */
  data: ArchiveResponse | null;
  detail: CandidateDetail | null;
  selected: string | undefined;
  problem: AnalysisProblem | null;
  busy: boolean;
  task: AnalysisTask | null;
  /** Change how the stored results are looked at; the answer is asked again after a moment. */
  change: (values: Partial<ArchiveQuery>) => void;
  /** Start over with another query (new sources, or a saved decision). */
  restart: (query: ArchiveQuery, revision?: string) => void;
  /** Recompute from the stored results, forgetting the revision the view was built on. */
  refresh: () => void;
  fail: (caught: unknown, doing?: string) => void;
  startFront: () => void;
  cancelFront: () => void;
  forgetFront: () => void;
}

/**
 * The state of one decision space: the query, the archive it returns, the detail of the binding in focus and the background front.
 * Every call is cancelled when it is replaced, and an answer for an older revision of the evidence is never drawn as current.
 */
export function useArchiveSession(initial: ArchiveQuery): ArchiveSession {
  const [query, setQuery] = useState<ArchiveQuery>(initial);
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [problem, setProblem] = useState<AnalysisProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [task, setTask] = useState<AnalysisTask | null>(null);
  const revision = useRef<string | undefined>(undefined);

  const selected = query.selected ?? data?.winners[0]?.id;
  const effective: ArchiveQuery = { ...query, selected, revision: query.revision ?? data?.revision };

  useEffect(() => {
    if (!query.sources.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      analysisApi.query({ ...query, revision: query.revision ?? revision.current }, controller.signal).then((response) => {
        if (controller.signal.aborted) return;
        revision.current = response.revision;
        setData(response);
        setProblem(null);
      }).catch((caught: unknown) => {
        if (!controller.signal.aborted) setProblem(analysisProblem(caught));
      }).finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    }, 120);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, refreshes]);

  useEffect(() => {
    if (!data || !selected || busy || problem) return;
    const controller = new AbortController();
    analysisApi.candidate({ ...query, selected, revision: data.revision }, controller.signal).then((value) => {
      if (!controller.signal.aborted && value.revision === data.revision) setDetail(value);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setProblem(analysisProblem(caught, 'inspect this binding'));
    });
    return () => controller.abort();
  }, [data, selected, query, busy, problem]);

  useEffect(() => {
    if (!task || !['queued', 'running'].includes(task.state)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      analysisApi.pareto(task.id, controller.signal).then((value) => {
        if (controller.signal.aborted) return;
        setTask(value);
        if (value.state === 'completed') setRefreshes((count) => count + 1);
      }).catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setProblem(analysisProblem(caught, 'follow the front'));
        setTask(null);
      });
    }, document.hidden ? 5000 : 1000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [task]);

  const change = (values: Partial<ArchiveQuery>) => {
    setBusy(true);
    setDetail(null);
    setQuery((current) => ({ ...current, ...values }));
  };

  const restart = (next: ArchiveQuery, nextRevision?: string) => {
    revision.current = nextRevision;
    setTask(null);
    setData(null);
    setDetail(null);
    setProblem(null);
    setQuery(next);
  };

  const refresh = () => {
    revision.current = undefined;
    setBusy(true);
    setQuery((current) => ({ ...current, revision: undefined }));
    setRefreshes((count) => count + 1);
  };

  return {
    query, effective, data, detail, selected, problem, busy, task,
    change, restart, refresh,
    fail: (caught, doing) => setProblem(analysisProblem(caught, doing)),
    startFront: () => { analysisApi.startPareto(effective).then(setTask).catch((caught: unknown) => setProblem(analysisProblem(caught, 'start the front'))); },
    cancelFront: () => { if (task) analysisApi.cancelPareto(task.id).then(setTask).catch((caught: unknown) => setProblem(analysisProblem(caught, 'cancel the front'))); },
    forgetFront: () => setTask(null),
  };
}
