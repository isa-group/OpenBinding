// Pattern only, after SPHERE frontend/src/modules/pricing/components/create-pricing-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's launch steps as the cards of SPHERE's create form: what to solve (a problem version), the exact
// engine mode, the settings (asked, what the plan allows, what the run will use) and "Before you send" with the size forecast
// and the countdown when every run slot is busy.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProblemCompilation } from '../../../../api/problems';
import { Action } from '../../../core/components/action-button';
import { Chip } from '../../../core/components/chip';
import { Notice } from '../../../core/components/notice';
import { useCountdown } from '../../../core/hooks/useCountdown';
import type { Refusal } from '../../utils/runErrors';
import type { ForecastBar } from '../../utils/runsModel';
import { allowsZero } from '../../utils/launchModel';
import type { ModeChoice, OptionPlan, SourceChoice } from '../../utils/launchModel';

export interface Prepared {
  choiceId: string;
  /** The compilation of the chosen version by the installed toolchain: its analysis and the engine modes that can run it. */
  analysis: { state: 'ok'; result: ProblemCompilation } | { state: 'failed'; refusal: Refusal };
  /** Some candidate of the compiled form holds a range, so only a mode that declares interval values can run it. */
  ranges?: boolean;
  /** How many criteria the compiled problem optimizes; `null` when the compiled form could not be read. */
  criteria?: number | null;
}

/** One step of the launch form: a numbered hairline card with its heading and the choice it holds so far. */
export function StepCard({
  number,
  title,
  note,
  children,
}: {
  number: number;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  const id = `launch-step-${number}`;
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-tp-primary/10 text-xs font-semibold text-tp-accent"
        >
          {number}
        </span>
        <h2 id={id} className="font-display text-lg text-tp-ink">
          {title}
        </h2>
        {note && <span className="ml-auto truncate text-xs text-tp-steel">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** A radio drawn as a selectable card (SPHERE's selected-card recipe: a primary border and tint when chosen). */
function ChoiceCard({
  name,
  value,
  checked,
  disabled,
  onChange,
  label,
  sub,
  warn,
  trailing,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  label: string;
  sub?: string;
  warn?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <label
      className={`flex min-w-0 items-start gap-3 rounded-lg border p-3 transition-colors ${
        disabled
          ? 'cursor-not-allowed border-tp-hairline bg-tp-surface/60 opacity-75'
          : checked
            ? 'cursor-pointer border-tp-primary bg-tp-primary/5'
            : 'cursor-pointer border-tp-hairline hover:border-tp-hairline-strong hover:bg-tp-surface/50'
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-tp-primary disabled:cursor-not-allowed"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="text-sm font-semibold [overflow-wrap:anywhere] text-tp-ink">
          {label}
        </strong>
        {sub && (
          <span
            className={`text-xs [overflow-wrap:anywhere] ${warn ? 'text-tp-warning-text' : 'text-tp-steel'}`}
          >
            {sub}
          </span>
        )}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </label>
  );
}

const muted = 'text-xs text-tp-steel';

// --- 1 · what to solve

export function SourceStep({
  choices,
  value,
  onChange,
  problemsHref,
}: {
  choices: readonly SourceChoice[];
  value: string;
  onChange: (id: string) => void;
  problemsHref: string;
}) {
  return (
    <>
      {choices.length === 0 && (
        <div className="rounded-lg border border-dashed border-tp-hairline-strong px-4 py-6 text-center text-sm text-tp-steel">
          Nothing to solve yet. The organization has no problem version.
        </div>
      )}
      {choices.length > 0 && (
        <div role="radiogroup" aria-label="Source" className="flex flex-col gap-2">
          {choices.map(choice => (
            <ChoiceCard
              key={choice.id}
              name="launch-source"
              value={choice.id}
              checked={value === choice.id}
              onChange={onChange}
              label={choice.label}
              sub={choice.detail}
            />
          ))}
        </div>
      )}
      <Action to={problemsHref} variant="link">
        Upload a problem
      </Action>
    </>
  );
}

// --- 2 · engine

export function EngineStep({
  modes,
  value,
  onChange,
  analysisNote,
  compareHref,
  hasPrepared,
  ranges = false,
  preset,
  attached,
}: {
  modes: readonly ModeChoice[];
  value: string;
  onChange: (key: string) => void;
  analysisNote: ReactNode;
  compareHref: string;
  hasPrepared: boolean;
  /** The package has ranges. */
  ranges?: boolean;
  /** "Start from a preset", above the engines. */
  preset?: ReactNode;
  /** The attached preset, shown instead of the engines: it carries the engine and the mode. */
  attached?: ReactNode;
}) {
  if (attached) {
    return (
      <>
        {analysisNote}
        {preset}
        {attached}
      </>
    );
  }
  return (
    <>
      {analysisNote}
      {preset}
      <div role="radiogroup" aria-label="Engine" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {modes.map(mode => (
          <ChoiceCard
            key={mode.key}
            name="launch-engine"
            value={mode.key}
            checked={value === mode.key}
            onChange={onChange}
            disabled={mode.compat === 'no'}
            warn={mode.compat === 'no'}
            label={mode.engine.name}
            sub={`${mode.engine.version} · mode ${mode.mode}${mode.compat === 'no' && mode.reason ? ` · ${mode.reason}` : ''}`}
            trailing={
              mode.compat === 'yes' ? (
                <Chip tone="success">
                  {mode.federated ? 'Can run this · your deployment' : 'Can run this'}
                </Chip>
              ) : mode.compat === 'no' ? (
                <Chip tone="warning">Can’t run this</Chip>
              ) : (
                <Chip>Checked when you send</Chip>
              )
            }
          />
        ))}
      </div>
      {hasPrepared && modes.length === 0 && (
        <span className={muted}>The gateway lists no engine mode for this problem.</span>
      )}
      {ranges && modes.some(mode => mode.rangeRefusal) && (
        <Notice tone="warning" title="This package has range features">
          {modes.every(mode => mode.compat === 'no')
            ? 'No engine mode accepts ranges yet, so the run would be refused (unsupported_capability_value). '
            : 'The engines marked “Can’t run this” only accept single values. '}
          Pick a mode that declares interval values (see{' '}
          <Link className="font-medium underline" to={compareHref}>
            Engines
          </Link>
          ), or give those candidates single values.
        </Notice>
      )}
      <Action to={compareHref} variant="link">
        Compare engines
      </Action>
    </>
  );
}

// --- 3 · settings

const amount = (value: number | null, unit: string) =>
  value === null ? '—' : `${value.toLocaleString('en-US')} ${unit}`.trim();

function OptionsTable({
  plans,
  values,
  onChange,
}: {
  plans: readonly OptionPlan[];
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      <div
        className="w-full overflow-x-auto rounded-xl border border-tp-hairline focus-visible:outline-2 focus-visible:outline-tp-primary"
        role="region"
        aria-label="Settings against your plan"
        tabIndex={0}
      >
        <table className="w-full min-w-[560px] border-collapse text-left text-sm text-tp-ink [&_tbody_tr]:border-t [&_tbody_tr]:border-tp-hairline-soft [&_td]:px-4 [&_td]:py-3 [&_td]:align-top [&_th]:px-4 [&_th]:py-2.5 [&_thead_th]:bg-tp-surface [&_thead_th]:text-[11px] [&_thead_th]:font-semibold [&_thead_th]:tracking-wide [&_thead_th]:text-tp-steel [&_thead_th]:uppercase">
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">You ask for</th>
              <th scope="col">Your plan allows</th>
              <th scope="col">Will run with</th>
            </tr>
          </thead>
          <tbody>
            {plans.map(plan => {
              const { input } = plan;
              const shown =
                input.name in values
                  ? values[input.name]
                  : input.default !== null
                    ? String(input.default)
                    : '';
              return (
                <tr key={input.name}>
                  <td>
                    <strong className="block font-semibold">{input.label}</strong>
                    <small className="text-xs text-tp-steel">
                      default{' '}
                      {input.default !== null
                        ? amount(input.default, input.unit)
                        : 'set by the engine'}
                    </small>
                  </td>
                  <td>
                    <label className="inline-flex items-center gap-2">
                      <span className="sr-only">{input.label}</span>
                      <input
                        className="h-9 w-28 rounded-md border border-tp-input-border bg-tp-input-bg px-2 text-sm text-tp-ink tabular-nums outline-none focus:border-tp-primary aria-invalid:border-tp-severity-error"
                        inputMode="numeric"
                        value={shown}
                        aria-invalid={plan.invalid || undefined}
                        onChange={event => onChange(input.name, event.target.value)}
                      />
                    </label>{' '}
                    <span className="text-xs text-tp-steel">{input.unit}</span>
                    {plan.invalid && (
                      <small className="block text-xs text-tp-error-text">
                        {allowsZero(input)
                          ? `${input.integer ? 'A whole number' : 'A number'}, 0 or more`
                          : 'A positive number'}
                      </small>
                    )}
                  </td>
                  <td>
                    {input.kind === 'other'
                      ? 'Not reduced (shape)'
                      : input.ceiling !== null
                        ? amount(input.ceiling, input.unit)
                        : 'No ceiling on your plan'}
                  </td>
                  <td>
                    {plan.effective === null ? (
                      <span className="text-tp-steel">The engine’s default</span>
                    ) : (
                      <Chip tone={plan.reduced ? 'warning' : 'success'}>
                        {amount(plan.effective, input.unit)}
                        {plan.reduced ? ' (reduced)' : ''}
                      </Chip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className={muted}>
        Values above your plan run at the ceiling and the run carries a note; it isn’t an error.
      </span>
    </>
  );
}

export function SettingsStep({
  plans,
  values,
  onValue,
  modeLabel,
}: {
  plans: readonly OptionPlan[];
  values: Record<string, string>;
  onValue: (name: string, value: string) => void;
  modeLabel: string;
}) {
  return (
    <>
      <span className={muted}>Settings for {modeLabel}.</span>
      {plans.length > 0 && <OptionsTable plans={plans} values={values} onChange={onValue} />}
      {plans.length === 0 && (
        <span className={muted}>
          This mode declares no numeric settings; it runs with the engine’s own defaults.
        </span>
      )}
    </>
  );
}

// --- 4 · before you send

export function ForecastBars({ bars }: { bars: readonly ForecastBar[] }) {
  if (bars.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {bars.map(bar => (
        <div key={bar.label} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-tp-slate">{bar.label}</span>
          <div
            className="relative h-2 overflow-hidden rounded-full bg-tp-hairline"
            aria-hidden="true"
          >
            <i
              className="absolute inset-y-0 left-0 block bg-tp-primary"
              style={{ width: `${bar.before}%` }}
            />
            <i
              className={`absolute inset-y-0 block ${bar.over ? 'bg-tp-severity-error' : 'bg-tp-primary/40'}`}
              style={{ left: `${bar.before}%`, width: `${bar.add}%` }}
            />
          </div>
          <span className={`text-xs ${bar.over ? 'text-tp-error-text' : 'text-tp-steel'}`}>
            {bar.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/** “A slot should free up in about 12 s”, counting down; the person can send again when it reaches zero. */
export function SlotCountdown({ seconds }: { seconds: number }) {
  const { left, done } = useCountdown(seconds);
  return (
    <span className="block text-xs font-medium" role="timer">
      {done
        ? 'A slot should be free now. Send again.'
        : `A slot should free up in about ${left} s.`}
    </span>
  );
}
