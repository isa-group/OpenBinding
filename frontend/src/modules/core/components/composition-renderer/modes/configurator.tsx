import { useEffect, useRef, useState } from 'react';
import { Action } from '../../action-button';
import { Notice } from '../../notice';
import type { CandidateMatrix as Matrix } from '../../../utils/binding/candidateMatrix';
import { compositionsApi } from '../../../utils/composition/api';
import { formatValue } from '../../../utils/composition/values';
import type { CompositionViewModel } from '../../../utils/composition/viewModel';
import type { EvaluateResult } from '../../../api/types';
import {
  createScheduler,
  pausedMessage,
  type Scheduler,
  type SchedulerStatus,
} from '../../../editor/lintScheduler';
import { CandidateMatrix } from '../../candidate-matrix/CandidateMatrix';
import { MarginTable } from '../../margin-table';
import { ValueBadge } from '../../value-badge/ValueBadge';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';
import {
  analysisRefusal,
  findingTask,
  type AnalysisActions,
  type AnalysisRefusal,
  type WrittenBinding,
} from './analysis';
import { violationText } from './calculatorModel';
import {
  changedBinding,
  fullBinding,
  selectedMatrix,
  sideBySide,
  startSelection,
  type Selection,
} from './configuratorModel';

/**
 * The configurator mode: choose a candidate per task. Each choice is evaluated by the toolchain (`evaluate`, 800 ms after the last
 * change, through the editors' scheduler), and its values are shown beside the version's, never subtracted from them. A binding
 * can be derived as a new version or opened in the Editor as a draft; the page answers both (`onDerive`, `onOpenDraft`).
 */

/** Milliseconds of stillness before a choice is evaluated (A-7). */
export const EVALUATE_DELAY = 800;

interface ConfiguratorModeProps {
  model: CompositionViewModel;
  sections: readonly Section[];
  actions?: AnalysisActions;
}

/** A finding of the gateway, with the task of the request it points at. */
interface Finding {
  code: string;
  message: string;
  task: string | null;
}

/** What the gateway answered for one binding, keyed by that binding. */
type Answer =
  | { key: string; state: 'ready'; result: EvaluateResult }
  | { key: string; state: 'refused'; refusal: AnalysisRefusal };

const keyOf = (binding: WrittenBinding) =>
  JSON.stringify(Object.entries(binding).sort(([a], [b]) => (a < b ? -1 : 1)));

/** What one evaluation is asked: the tasks bound otherwise, and the demand (users, a revision of the problem). */
interface Asked {
  binding: WrittenBinding;
  users?: number;
  revision?: number;
}

const askedKey = (asked: Asked) =>
  JSON.stringify([keyOf(asked.binding), asked.users ?? null, asked.revision ?? null]);

function FindingList({ findings, label }: { findings: Finding[]; label: string }) {
  if (findings.length === 0) return null;
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px] [&_code]:font-mono [&_code]:text-[13px] [&_code]:[overflow-wrap:anywhere]"
      aria-label={label}
    >
      {findings.map((finding, index) => (
        <li key={`${finding.code}-${finding.task ?? ''}-${index}`}>
          {finding.task && (
            <>
              <span>Task</span> <code>{finding.task}</code>:{' '}
            </>
          )}
          {finding.message} <code>{finding.code}</code>
        </li>
      ))}
    </ul>
  );
}

function Values({ model, result }: { model: CompositionViewModel; result: EvaluateResult }) {
  const rows = sideBySide(model.values, result.values);
  const versionStatus = model.status.values ?? 'unverified';
  if (rows.length === 0)
    return (
      <p className="cr-muted m-0 text-[13px] text-tp-steel">
        The toolchain computed no values for this binding.
      </p>
    );
  return (
    <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-tp-hairline-soft [&_td]:px-2 [&_td]:py-1.5 [&_td]:text-left [&_td]:align-top [&_td]:[overflow-wrap:anywhere] [&_th]:border-b [&_th]:border-tp-hairline-soft [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:align-top [&_th]:[overflow-wrap:anywhere] [&_thead_th]:text-xs [&_thead_th]:font-semibold [&_thead_th]:text-tp-steel">
      <caption className="sr-only">The version’s values and this binding’s, side by side</caption>
      <thead>
        <tr>
          <th scope="col">Value</th>
          <th scope="col">
            {`Version ${model.version?.label ?? ''}`} <ValueBadge status={versionStatus} />
          </th>
          <th scope="col">
            This binding <ValueBadge status={result.valid ? 'verified' : 'unverified'} />
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.name}>
            <th scope="row">{row.name}</th>
            <td>{row.version ? formatValue(row.version.value, row.version.unit) : '—'}</td>
            <td>{row.evaluated ? formatValue(row.evaluated.value, row.evaluated.unit) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Configurator({
  model,
  matrix,
  sections,
  actions = {},
}: ConfiguratorModeProps & { matrix: Matrix }) {
  const { org, slug } = model.identity;
  const version = model.version?.id ?? '';
  const base = model.selection;
  const [selection, setSelection] = useState<Selection>(() =>
    startSelection(matrix, base, actions.start)
  );
  const [status, setStatus] = useState<SchedulerStatus>({ state: 'idle' });
  const [answer, setAnswer] = useState<Answer | null>(null);
  const scheduler = useRef<Scheduler<Asked> | null>(null);
  const notLinked = useRef(actions.onNotLinked);
  useEffect(() => {
    notLinked.current = actions.onNotLinked;
  });

  const changed = changedBinding(matrix, base, selection);
  const rebound = Object.keys(changed).length > 0;
  const demand = actions.demand ?? {};
  const asked: Asked = { binding: changed, users: demand.users, revision: demand.revision };
  const key = askedKey(asked);
  // A demand (users, a revision) has the toolchain evaluate even the version's own binding.
  const pending = rebound || demand.users !== undefined || demand.revision !== undefined;
  const demandRefused = useRef(actions.onDemandRefused);
  useEffect(() => {
    demandRefused.current = actions.onDemandRefused;
  });

  useEffect(() => {
    const created = createScheduler<Asked, EvaluateResult>({
      delay: EVALUATE_DELAY,
      run: (payload, signal) =>
        compositionsApi.evaluate(
          org,
          slug,
          {
            version,
            binding: payload.binding,
            ...(payload.users !== undefined ? { users: payload.users } : {}),
            ...(payload.revision !== undefined ? { revision: payload.revision } : {}),
          },
          signal
        ),
      onResult: (result, payload) => setAnswer({ key: askedKey(payload), state: 'ready', result }),
      onError: (caught, payload) => {
        const refusal = analysisRefusal(caught, 'This binding couldn’t be evaluated');
        setAnswer({ key: askedKey(payload), state: 'refused', refusal });
        if (refusal.notLinked) notLinked.current?.();
        else if (payload.revision !== undefined)
          demandRefused.current?.(
            [refusal.message, ...refusal.findings.map(finding => finding.message)].join(' ')
          );
      },
      onStatus: setStatus,
    });
    scheduler.current = created;
    return () => {
      created.dispose();
      if (scheduler.current === created) scheduler.current = null;
    };
  }, [org, slug, version]);

  useEffect(() => {
    const current = scheduler.current;
    if (!current) return;
    const [bindingKey, users, revision] = JSON.parse(key) as [string, number | null, number | null];
    const now: Asked = {
      binding: Object.fromEntries(JSON.parse(bindingKey) as Array<[string, string]>),
      ...(users !== null ? { users } : {}),
      ...(revision !== null ? { revision } : {}),
    };
    const active =
      Object.keys(now.binding).length > 0 || now.users !== undefined || now.revision !== undefined;
    if (!active) current.cancel();
    else current.schedule(now);
  }, [key]);

  const shown = answer && answer.key === key && pending ? answer : null;
  const findings: Finding[] =
    shown?.state === 'ready'
      ? shown.result.diagnostics.map(item => ({
          code: item.code,
          message: item.message,
          task: findingTask(item.pointer),
        }))
      : shown?.state === 'refused'
        ? shown.refusal.findings.map(item => ({
            code: item.code,
            message: item.message,
            task: findingTask(item.pointer),
          }))
        : [];
  const flagged = new Set(findings.flatMap(finding => (finding.task ? [finding.task] : [])));
  // The binding is derived on the problem version it was evaluated against: the demand's revision when one is chosen (a
  // revision made by "Update from SPHERE", F6), the version's own otherwise.
  const linked = model.status.problemRevision;
  const revision =
    linked && demand.revision !== undefined
      ? linked.replace(/@\d+$/, `@${demand.revision}`)
      : linked;
  const source = revision ? { revision, binding: fullBinding(model, changed) } : null;
  const comparable = model.status.values === 'verified';

  const result = (
    <RendererSection title="This binding">
      {!pending && (
        <p className="cr-muted m-0 text-[13px] text-tp-steel">
          This is the version’s binding. Choose another candidate for a task to have the toolchain
          evaluate it.
        </p>
      )}
      {pending && !rebound && (
        <p className="cr-muted m-0 text-[13px] text-tp-steel">
          The version’s binding, evaluated under the demand chosen above.
        </p>
      )}
      {pending && status.state === 'paused' && (
        <p className="cr-muted m-0 text-[13px] text-tp-steel" role="status">
          {pausedMessage(status.until)}
        </p>
      )}
      {pending && !shown && status.state !== 'paused' && (
        <p className="cr-muted m-0 text-[13px] text-tp-steel" role="status">
          The toolchain is evaluating this binding…
        </p>
      )}
      {shown?.state === 'refused' &&
        (shown.refusal.notLinked ? (
          <p className="cr-muted m-0 text-[13px] text-tp-steel">{shown.refusal.message}</p>
        ) : (
          <Notice tone="error">
            {shown.refusal.message}
            <FindingList findings={findings} label="What the gateway found" />
          </Notice>
        ))}
      {shown?.state === 'ready' && (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0 text-sm font-semibold text-tp-ink" role="status">
            {shown.result.valid
              ? 'Valid: the toolchain reports no broken hard rule.'
              : 'Not valid: this binding breaks a hard rule.'}
          </p>
          {shown.result.violations.length > 0 && (
            <ul
              className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-[13px] text-tp-slate"
              aria-label="Rules broken"
            >
              {shown.result.violations.map((violation, index) => (
                <li key={`${violationText(violation)}-${index}`}>{violationText(violation)}</li>
              ))}
            </ul>
          )}
          <FindingList findings={findings} label="What the toolchain found" />
          {!comparable && (
            <Notice tone="warning" title="Not comparable">
              {`The values of version ${model.version?.label ?? ''} are ${model.status.values ?? 'unverified'}: read them beside this binding’s, not against them.`}
            </Notice>
          )}
          <Values model={model} result={shown.result} />
          {shown.result.revision && (
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 text-[13px] font-semibold text-tp-ink">
                {`Demand of problem version ${shown.result.revision.number}`}
              </p>
              {shown.result.revision.demand.length === 0 ? (
                <p className="cr-muted m-0 text-[13px] text-tp-steel">
                  This problem version was not generated from SPHERE, so it states no demand.
                </p>
              ) : (
                <ul
                  aria-label="Demand evaluated"
                  className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px] text-tp-slate"
                >
                  {shown.result.revision.demand.map(item => (
                    <li key={item.name}>
                      {`${item.name}: ${item.value === null ? '—' : String(item.value)} ${item.unit}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {shown.result.margins && <MarginTable margins={shown.result.margins} />}
        </div>
      )}
      {rebound && (
        <div className="flex flex-wrap gap-2">
          <Action variant="secondary" onClick={() => setSelection(base)}>
            Back to the version’s binding
          </Action>
          {actions.onOpenDraft && source && (
            <Action variant="secondary" onClick={() => actions.onOpenDraft?.(source)}>
              Open as a draft
            </Action>
          )}
          {actions.onDerive && source && (
            <Action variant="primary" onClick={() => actions.onDerive?.(source)}>
              Derive as a new version
            </Action>
          )}
        </div>
      )}
    </RendererSection>
  );

  return (
    <>
      {sections.includes('result') && result}
      {sections.includes('choice') && (
        <RendererSection title="Choose per task">
          <p className="cr-muted m-0 text-[13px] text-tp-steel">
            The candidates of the linked problem, on the compilation this version’s values were
            evaluated on. The selected ones start as the version’s binding.
          </p>
          <CandidateMatrix
            matrix={selectedMatrix(matrix, selection)}
            mode="select"
            label="Candidates to choose from"
            onSelect={(task, candidate) => setSelection(now => ({ ...now, [task]: candidate }))}
            tags={(task, candidate) =>
              flagged.has(task) && selection[task] === candidate ? ['See the finding'] : []
            }
          />
        </RendererSection>
      )}
    </>
  );
}

export function ConfiguratorMode({ model, sections, actions }: ConfiguratorModeProps) {
  if (!model.version || !model.modes.includes('configurator')) return null;
  if (!model.matrix) {
    return sections.includes('choice') ? (
      <RendererSection title="Choose per task">
        <p className="cr-muted m-0 text-[13px] text-tp-steel">
          The candidates of the linked problem are not loaded yet.
        </p>
      </RendererSection>
    ) : null;
  }
  return (
    <Configurator
      key={model.version.id}
      model={model}
      matrix={model.matrix}
      sections={sections}
      actions={actions}
    />
  );
}
