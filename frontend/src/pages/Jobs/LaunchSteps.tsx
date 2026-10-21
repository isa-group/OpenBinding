import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { SnapshotAnalysis } from '../../api/cases';
import type { ArtifactVersion } from '../../api/library';
import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { useCountdown } from '../../components/ui/useCountdown';
import { Choice } from '../Organization/parts';
import type { Refusal } from './jobErrors';
import type { ForecastBar } from './jobsModel';
import { allowsZero } from './launchModel';
import type { ModeChoice, OptionPlan, SettingsSource, SourceChoice } from './launchModel';

export interface Prepared {
  choiceId: string;
  snapshotId: string;
  analysis: { state: 'ok'; result: SnapshotAnalysis } | { state: 'failed'; refusal: Refusal };
  /** Some candidate of the compiled form holds a range, so only a mode that declares interval values can run it. */
  ranges?: boolean;
  /** How many criteria the compiled problem optimizes; `null` when the compiled form could not be read. */
  criteria?: number | null;
}

// --- 1 · what to solve

export function SourceStep({ choices, value, onChange, workbenchHref }: {
  choices: readonly SourceChoice[]; value: string; onChange: (id: string) => void; workbenchHref: string;
}) {
  return (
    <>
      <h2>What to solve</h2>
      {choices.length === 0 && (
        <div className="job-empty">Nothing to solve yet. This project has no case revision, and no snapshot was chosen.</div>
      )}
      {choices.length > 0 && (
        <div role="radiogroup" aria-label="Source" className="job-choices">
          {choices.map((choice) => (
            <Choice key={choice.id} name="job-source" value={choice.id} checked={value === choice.id} onChange={onChange} label={choice.label} sub={choice.detail} />
          ))}
        </div>
      )}
      <Action to={workbenchHref} variant="link">Upload a new package in the Workbench</Action>
    </>
  );
}

// --- 2 · engine

export function EngineStep({ modes, value, onChange, analysisNote, compareHref, hasPrepared, ranges = false, editHref }: {
  modes: readonly ModeChoice[]; value: string; onChange: (key: string) => void; analysisNote: ReactNode; compareHref: string; hasPrepared: boolean;
  /** The package has ranges. */
  ranges?: boolean;
  /** Where the candidates can be edited (the library). */
  editHref?: string;
}) {
  return (
    <>
      <h2>Engine</h2>
      {analysisNote}
      <div role="radiogroup" aria-label="Engine" className="job-choices is-grid">
        {modes.map((mode) => (
          <Choice
            key={mode.key} name="job-engine" value={mode.key} checked={value === mode.key} onChange={onChange} disabled={mode.compat === 'no'}
            warn={mode.compat === 'no'}
            label={mode.engine.name}
            sub={`${mode.engine.version} · mode ${mode.mode}${mode.compat === 'no' && mode.reason ? ` · ${mode.reason}` : ''}`}
            trailing={mode.compat === 'yes'
              ? <Chip tone="success">{mode.federated ? 'Can run this · your deployment' : 'Can run this'}</Chip>
              : mode.compat === 'no' ? <Chip tone="warning">Can’t run this</Chip> : <Chip>Checked when you send</Chip>}
          />
        ))}
      </div>
      {hasPrepared && modes.length === 0 && <p className="org-muted">The gateway lists no engine mode for this problem.</p>}
      {ranges && modes.some((mode) => mode.rangeRefusal) && (
        <Notice tone="warning" title="This package has range features">
          {modes.every((mode) => mode.compat === 'no')
            ? 'No engine mode accepts ranges yet, so the run would be refused (unsupported_capability_value). '
            : 'The engines marked “Can’t run this” only accept single values. '}
          Pick a mode that declares interval values (see <Link className="ui-notice-link" to={compareHref} viewTransition>Engines</Link>), or give those candidates single values{editHref ? <> (<Link className="ui-notice-link" to={editHref} viewTransition>edit the candidates</Link>)</> : ''}.
        </Notice>
      )}
      <Action to={compareHref} variant="link">Compare engines</Action>
    </>
  );
}

// --- 3 · settings

const amount = (value: number | null, unit: string) => (value === null ? '—' : `${value.toLocaleString('en-US')} ${unit}`.trim());

function OptionsTable({ plans, values, onChange }: { plans: readonly OptionPlan[]; values: Record<string, string>; onChange: (name: string, value: string) => void }) {
  return (
    <>
      <div className="job-table job-options" role="region" aria-label="Settings against your plan" tabIndex={0}>
        <table>
          <thead>
            <tr><th scope="col">Setting</th><th scope="col">You ask for</th><th scope="col">Your plan allows</th><th scope="col">Will run with</th></tr>
          </thead>
          <tbody>
            {plans.map((plan) => {
              const { input } = plan;
              const shown = input.name in values ? values[input.name] : input.default !== null ? String(input.default) : '';
              return (
                <tr key={input.name}>
                  <td><strong>{input.label}</strong><small className="org-muted">default {input.default !== null ? amount(input.default, input.unit) : 'set by the engine'}</small></td>
                  <td data-label="You ask for">
                    <label>
                      <span className="sr-only">{input.label}</span>
                      <input
                        className="job-number" inputMode="numeric" value={shown} aria-invalid={plan.invalid || undefined}
                        onChange={(event) => onChange(input.name, event.target.value)}
                      />
                    </label>{' '}
                    <span className="org-muted">{input.unit}</span>
                    {plan.invalid && <small className="job-invalid">{allowsZero(input) ? `${input.integer ? 'A whole number' : 'A number'}, 0 or more` : 'A positive number'}</small>}
                  </td>
                  <td data-label="Your plan allows">{input.kind === 'other' ? 'Not reduced (shape)' : input.ceiling !== null ? amount(input.ceiling, input.unit) : 'No ceiling on your plan'}</td>
                  <td data-label="Will run with">
                    {plan.effective === null ? <span className="org-muted">The engine’s default</span> : (
                      <Chip tone={plan.reduced ? 'warning' : 'success'}>{amount(plan.effective, input.unit)}{plan.reduced ? ' (reduced)' : ''}</Chip>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="org-muted">Values above your plan run at the ceiling and the job carries a note; it isn’t an error.</span>
    </>
  );
}

export function SettingsStep({ org, source, onSource, plans, values, onValue, configuration, onConfiguration, libraryHref, modeLabel }: {
  org: string; source: SettingsSource; onSource: (next: SettingsSource) => void;
  plans: readonly OptionPlan[]; values: Record<string, string>; onValue: (name: string, value: string) => void;
  configuration: ArtifactVersion | null; onConfiguration: (version: ArtifactVersion) => void; libraryHref: string; modeLabel: string;
}) {
  const name = useId();
  return (
    <>
      <h2>Settings</h2>
      <fieldset className="proj-seg" aria-label="Settings source">
        <label className={source === 'inline' ? 'is-checked' : ''}>
          <input type="radio" name={`${name}-source`} checked={source === 'inline'} onChange={() => onSource('inline')} />Set them here
        </label>
        <label className={source === 'saved' ? 'is-checked' : ''}>
          <input type="radio" name={`${name}-source`} checked={source === 'saved'} onChange={() => onSource('saved')} />Use saved settings
        </label>
      </fieldset>
      {source === 'inline' && (
        <>
          <p className="org-muted">Settings for {modeLabel}.</p>
          {plans.length > 0 && <OptionsTable plans={plans} values={values} onChange={onValue} />}
          {plans.length === 0 && <p className="org-muted">This mode declares no numeric settings; it runs with the engine’s own defaults.</p>}
        </>
      )}
      {source === 'saved' && (
        <div className="job-saved">
          <ArtifactVersionPicker org={org} kind="ExecutionConfiguration" versionId={configuration?.id} onSelect={(_, version) => onConfiguration(version)} />
          <div className="job-note-card">
            <strong>{configuration ? `${configuration.ref.name} · v${configuration.ref.version}` : 'No saved settings chosen'}</strong>
            <span>Saved run settings from the library. Using them replaces the fields of “Set them here”, and the engine, mode and options come from them; you can’t mix both.</span>
            <Action to={libraryHref} variant="link" size="sm">Open the library</Action>
          </div>
        </div>
      )}
    </>
  );
}

// --- 4 · before you send

export function ForecastBars({ bars }: { bars: readonly ForecastBar[] }) {
  return (
    <div className="job-forecast">
      {bars.map((bar) => (
        <div key={bar.label} className="job-forecast-item">
          <span className="job-forecast-label">{bar.label}</span>
          <div className="job-bar" aria-hidden="true">
            <i className="is-before" style={{ width: `${bar.before}%` }} />
            <i className={`is-add${bar.over ? ' is-over' : ''}`} style={{ left: `${bar.before}%`, width: `${bar.add}%` }} />
          </div>
          <span className={`job-forecast-text${bar.over ? ' is-over' : ''}`}>{bar.text}</span>
        </div>
      ))}
    </div>
  );
}

/** “A slot should free up in about 12 s”, counting down; the person can send again when it reaches zero. */
export function SlotCountdown({ seconds }: { seconds: number }) {
  const { left, done } = useCountdown(seconds);
  return <span className="job-refusal-line" role="timer">{done ? 'A slot should be free now. Send again.' : `A slot should free up in about ${left} s.`}</span>;
}
