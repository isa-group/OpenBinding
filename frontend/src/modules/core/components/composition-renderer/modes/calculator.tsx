// Design follows SPHERE frontend/src/modules/pricing/components/configuration-space-view/index.tsx (revision 73779a8a); no code copied
import { useEffect, useRef, useState } from 'react';
import { Action } from '../../action-button';
import { Chip } from '../../chip';
import { DataTable } from '../../data-table';
import { Notice } from '../../notice';
import { COMPARISON_WORDS, comparisonText } from '../../../utils/binding/comparison';
import { compositionsApi } from '../../../utils/composition/api';
import type { CompositionViewModel } from '../../../utils/composition/viewModel';
import type { CompositionNeighborhoodResponse } from '../../../api/types';
import type { Section } from '../presets';
import { RendererSection } from '../RendererSection';
import { analysisRefusal, type AnalysisActions, type AnalysisRefusal } from './analysis';
import {
  NO_FILTER,
  moveRows,
  rowChoices,
  signed,
  visibleRows,
  withMove,
  writtenBinding,
  type MoveFilter,
  type MoveRow,
} from './calculatorModel';
import './analysis.css';

/**
 * The calculator mode: one change at a time. The toolchain evaluates every candidate a task could take instead of the version's
 * (`neighborhood`), and the table lists each move with the gateway's comparison word and the deltas it computed. A person narrows
 * the moves by text, task and comparison, walks them one by one, tries one in the configurator or derives it as a version; the
 * page answers both (`onTry`, `onDerive`).
 */

/** How many moves the toolchain evaluates at most for one look. */
export const NEIGHBOURHOOD_LIMIT = 64;

type Neighbourhood =
  | { state: 'loading' }
  | { state: 'ready'; response: CompositionNeighborhoodResponse }
  | { state: 'refused'; refusal: AnalysisRefusal };

interface CalculatorModeProps {
  model: CompositionViewModel;
  sections: readonly Section[];
  actions?: AnalysisActions;
}

function Deltas({ row }: { row: MoveRow }) {
  return (
    <ul className="cr-calc-deltas" aria-label="Changes in the objectives">
      {row.deltas.map((delta, position) => (
        <li key={`${delta.feature}-${position}`}>
          <span>{delta.feature}</span>{' '}
          <b>
            {delta.value === null
              ? '—'
              : `${signed(delta.value)}${delta.unit && delta.unit !== '1' ? ` ${delta.unit}` : ''}`}
          </b>
          {delta.loss !== null && <small>{` loss ${signed(delta.loss)}`}</small>}
        </li>
      ))}
      <li>
        <span>penalty</span> <b>{signed(row.penaltyDelta)}</b>
      </li>
    </ul>
  );
}

function Neighbourhood({
  model,
  actions = {},
}: {
  model: CompositionViewModel;
  actions?: AnalysisActions;
}) {
  const { org, slug } = model.identity;
  const version = model.version?.id ?? '';
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; value: Neighbourhood } | null>(null);
  const [filter, setFilter] = useState<MoveFilter>(NO_FILTER);
  const [focus, setFocus] = useState<number | null>(null);
  const key = `${org}/${slug}/${version}/${attempt}`;
  // The page's answer to a version that links no problem after all; read when the gateway says so, so a new callback each render
  // never asks for the moves again.
  const notLinked = useRef(actions.onNotLinked);
  useEffect(() => {
    notLinked.current = actions.onNotLinked;
  });

  useEffect(() => {
    let active = true;
    compositionsApi.neighborhood(org, slug, { version, limit: NEIGHBOURHOOD_LIMIT }).then(
      response => {
        if (active) setLoaded({ key, value: { state: 'ready', response } });
      },
      (caught: unknown) => {
        if (!active) return;
        const refusal = analysisRefusal(caught, 'The moves couldn’t be evaluated');
        setLoaded({ key, value: { state: 'refused', refusal } });
        if (refusal.notLinked) notLinked.current?.();
      }
    );
    return () => {
      active = false;
    };
  }, [org, slug, version, key]);

  const neighbourhood: Neighbourhood =
    loaded && loaded.key === key ? loaded.value : { state: 'loading' };
  if (neighbourhood.state === 'loading') {
    return (
      <p className="cr-muted m-0 text-[13px] text-tp-steel" role="status">
        The toolchain is evaluating each candidate a task could take instead…
      </p>
    );
  }
  if (neighbourhood.state === 'refused') {
    const { refusal } = neighbourhood;
    return refusal.notLinked ? (
      <p className="cr-muted m-0 text-[13px] text-tp-steel">{refusal.message}</p>
    ) : (
      <Notice
        tone="error"
        action={
          <Action variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>
            Retry
          </Action>
        }
      >
        {refusal.message}
      </Notice>
    );
  }

  const { response } = neighbourhood;
  const rows = moveRows(response.moves, model);
  const shown = visibleRows(rows, filter);
  const choices = rowChoices(rows);
  const at = Math.max(
    0,
    shown.findIndex(row => row.index === focus)
  );
  const focused = shown[at] ?? null;
  const current = writtenBinding(model);
  const revision = model.status.problemRevision;
  const narrow = (next: Partial<MoveFilter>) => {
    setFilter(now => ({ ...now, ...next }));
    setFocus(null);
  };
  const coverage = response.coverage;

  return (
    <div className="cr-calc">
      <p className="cr-calc-conclusion">{response.conclusion}</p>
      {rows.length > 0 && (
        <div className="cr-calc-filters">
          <label>
            <span>Search</span>
            <input
              type="search"
              value={filter.query}
              placeholder="Candidate or provider"
              aria-label="Search candidates and providers"
              onChange={event => narrow({ query: event.target.value })}
            />
          </label>
          <label>
            <span>Task</span>
            <select
              aria-label="Task"
              value={filter.task}
              onChange={event => narrow({ task: event.target.value })}
            >
              <option value="">All tasks</option>
              {choices.tasks.map(task => (
                <option key={task} value={task}>
                  {task}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Comparison</span>
            <select
              aria-label="Comparison"
              value={filter.comparison}
              onChange={event => narrow({ comparison: event.target.value })}
            >
              <option value="">Any comparison</option>
              {choices.comparisons.map(word => (
                <option key={word} value={word}>
                  {comparisonText(word).label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {rows.length > 0 && shown.length === 0 && (
        <p className="cr-muted m-0 text-[13px] text-tp-steel">
          No move matches. Clear the search or choose another task or comparison.
        </p>
      )}
      {focused && (
        <div className="cr-calc-focus">
          <p aria-live="polite">
            {`Move ${at + 1} of ${shown.length}: `}
            <code>{focused.task}</code> <code>{focused.from ?? '—'}</code>
            {' → '}
            <code>{focused.to}</code>
          </p>
          <Action
            variant="secondary"
            size="sm"
            disabled={at === 0}
            onClick={() => setFocus(shown[at - 1].index)}
          >
            Previous
          </Action>
          <Action
            variant="secondary"
            size="sm"
            disabled={at >= shown.length - 1}
            onClick={() => setFocus(shown[at + 1].index)}
          >
            Next
          </Action>
        </div>
      )}
      {shown.length > 0 && (
        <DataTable
          label={`Moves of ${model.identity.name} ${model.version?.label ?? ''}`.trim()}
          minWidth={0}
        >
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Change</th>
              <th scope="col">Comparison</th>
              <th scope="col">Objectives</th>
              <th scope="col">Rules</th>
              {(actions.onTry || actions.onDerive) && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody className="cr-calc-table">
            {shown.map(row => {
              const word = row.comparison
                ? COMPARISON_WORDS[row.comparison]
                : comparisonText(row.comparisonSent);
              const binding = withMove(current, row.task, row.to);
              return (
                <tr
                  key={row.index}
                  className={row === focused ? 'is-focused' : undefined}
                  aria-current={row === focused ? 'true' : undefined}
                >
                  <th scope="row" data-label="Task">
                    <code>{row.task}</code>
                  </th>
                  <td data-label="Change">
                    <code>{row.from ?? '—'}</code> <span aria-hidden="true">→</span>
                    <span className="sr-only">to</span> <code>{row.to}</code>
                    {row.provider && <small className="cr-calc-provider">{row.provider}</small>}
                  </td>
                  <td data-label="Comparison">
                    <Chip tone={word.tone}>{word.label}</Chip>
                  </td>
                  <td data-label="Objectives">
                    <Deltas row={row} />
                  </td>
                  <td data-label="Rules">
                    {row.feasible ? 'Feasible' : 'Breaks a hard rule'}
                    {row.violations.length > 0 && (
                      <ul className="cr-calc-violations" aria-label="Rules broken">
                        {row.violations.map((text, position) => (
                          <li key={`${text}-${position}`}>{text}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  {(actions.onTry || actions.onDerive) && (
                    <td data-label="Actions" className="cr-calc-actions">
                      {actions.onTry && (
                        <Action
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setFocus(row.index);
                            actions.onTry?.(binding);
                          }}
                        >
                          Try in configurator
                        </Action>
                      )}
                      {actions.onDerive && revision && (
                        <Action
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setFocus(row.index);
                            actions.onDerive?.({ revision, binding });
                          }}
                        >
                          Derive composition
                        </Action>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
      <p className="cr-muted m-0 text-[13px] text-tp-steel">
        {`Evaluated ${coverage.evaluated} of ${coverage.total} moves (up to ${coverage.limit}) on the installed toolchain.`}
        {coverage.complete
          ? ''
          : ' Coverage is incomplete: moves left unchecked may change the picture.'}
        {response.failures.length > 0 ? ` ${response.failures.length} could not be evaluated.` : ''}
      </p>
    </div>
  );
}

export function CalculatorMode({ model, sections, actions }: CalculatorModeProps) {
  if (!model.version || !model.modes.includes('calculator') || !sections.includes('moves'))
    return null;
  return (
    <RendererSection title="One change at a time">
      <p className="cr-muted m-0 text-[13px] text-tp-steel">
        Each candidate one task could take instead of this version’s, evaluated by the toolchain
        against this binding. The comparison and every change are the gateway’s.
      </p>
      <Neighbourhood key={model.version.id} model={model} actions={actions} />
    </RendererSection>
  );
}
