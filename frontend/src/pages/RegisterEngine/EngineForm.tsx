import { useState } from 'react';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { StatusChip } from '../Engines/EngineParts';
import { dimensionLabel, valueLabel } from '../Engines/manifestModel';
import {
  ALL_TERMINATIONS, SCALARIZATIONS, issueAt, newMode, newOption, vocabularyFor,
  type Choice, type Dimension, type EngineDraft, type Issue, type ModeDraft, type OptionDraft, type OptionType, type Selector, type Vocabulary,
} from './engineDraft';
import type { Termination } from '../../api/client';

interface Option<T extends string> {
  id: T;
  label: string;
}

function Segmented<T extends string>({ label, options, value, onChange, disabled }: {
  label: string;
  options: ReadonlyArray<Option<T>>;
  value: T;
  onChange: (id: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="rg-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={option.id === value} disabled={disabled} onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Chips({ label, options, selected, onToggle, disabled }: {
  label: string;
  options: ReadonlyArray<Option<string>>;
  selected: string[];
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="rg-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={selected.includes(option.id)} disabled={disabled} onClick={() => onToggle(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/** Values typed as a comma separated list: what the text says is kept while it is being typed. */
function ValuesInput({ label, values, onChange, disabled }: { label: string; values: string[]; onChange: (values: string[]) => void; disabled: boolean }) {
  const [text, setText] = useState(() => values.join(', '));
  return (
    <label className="rg-inline">
      <span>{label}</span>
      <input
        value={text}
        disabled={disabled}
        spellCheck={false}
        placeholder="qos-binding-placement/v1, …"
        onChange={(event) => {
          setText(event.target.value);
          onChange(event.target.value.split(',').map((item) => item.trim()).filter(Boolean));
        }}
      />
    </label>
  );
}

const PLACEMENT_LABELS: ReadonlyArray<Option<Selector>> = [
  { id: 'none', label: 'None' },
  { id: 'all', label: 'All placements' },
  { id: 'only', label: 'Only some' },
];

function CapabilityRow({ dimension, choice, disabled, error, onChange }: {
  dimension: Dimension;
  choice: Choice;
  disabled: boolean;
  error: string | undefined;
  onChange: (choice: Choice) => void;
}) {
  const label = dimensionLabel(dimension.id);
  const options: ReadonlyArray<Option<Selector>> = dimension.id === 'placement'
    ? PLACEMENT_LABELS
    : dimension.open
      ? [{ id: 'none', label: 'Nothing' }, { id: 'only', label: 'Only these' }]
      : [{ id: 'none', label: 'Nothing' }, { id: 'all', label: 'Everything' }, { id: 'only', label: 'Only these' }];
  return (
    <div className="rg-cap">
      <div className="rg-cap-head">
        <span>{label}</span>
        <Segmented label={label} options={options} value={choice.selector} disabled={disabled} onChange={(selector) => onChange({ selector, values: selector === 'only' ? choice.values : [] })} />
      </div>
      {choice.selector === 'only' && dimension.values.length > 0 && (
        <Chips
          label={`${label}: values`}
          options={dimension.values.map((value) => ({ id: value, label: valueLabel(dimension.id, value) }))}
          selected={choice.values}
          disabled={disabled}
          onToggle={(id) => onChange({ selector: 'only', values: toggled(choice.values, id) })}
        />
      )}
      {choice.selector === 'only' && dimension.open && (
        <ValuesInput label={`${label}: values`} values={choice.values} disabled={disabled} onChange={(values) => onChange({ selector: 'only', values })} />
      )}
      {error && <span className="rg-error" role="alert">{error}</span>}
    </div>
  );
}

function FeatureValuesEditor({ choice, disabled, onChange }: { choice: Choice; disabled: boolean; onChange: (choice: Choice) => void }) {
  const selected = choice.selector === 'all' ? ['scalar', 'interval'] : choice.selector === 'only' ? choice.values : [];
  const toggle = (id: string) => {
    const next = toggled(selected, id);
    onChange(next.length ? { selector: 'only', values: next } : { selector: 'none', values: [] });
  };
  const tiles = [
    { id: 'scalar', title: 'Scalar values', text: 'Each feature of a candidate is one number.' },
    { id: 'interval', title: 'Interval values (ranges)', text: 'A feature may be a range, min–max.' },
  ];
  return (
    <div className="rg-features">
      <div className="rg-field-label">Feature values it can read</div>
      <div className="rg-tiles" role="group" aria-label="Feature values">
        {tiles.map((tile) => (
          <button key={tile.id} type="button" aria-pressed={selected.includes(tile.id)} disabled={disabled} onClick={() => toggle(tile.id)}>
            <strong>{tile.title}</strong>
            <span>{tile.text}</span>
          </button>
        ))}
      </div>
      <small>
        Ranges are valid BIM syntax, and a manifest may declare them. The bundled engines declare scalar only, so a job whose candidates
        carry an interval is refused with <code>unsupported_capability_value</code> unless the mode names intervals here.
      </small>
    </div>
  );
}

const OPTION_TYPES: ReadonlyArray<Option<OptionType>> = [
  { id: 'integer', label: 'Whole number' },
  { id: 'number', label: 'Number' },
  { id: 'string', label: 'Text' },
  { id: 'boolean', label: 'Yes / no' },
];

function OptionRow({ option, index, disabled, issues, at, onChange, onRemove }: {
  option: OptionDraft;
  index: number;
  disabled: boolean;
  issues: Issue[];
  at: string;
  onChange: (option: OptionDraft) => void;
  onRemove: () => void;
}) {
  const numeric = option.type === 'integer' || option.type === 'number';
  const field = (name: 'name' | 'minimum' | 'maximum' | 'default') => issueAt(issues, `${at}.${name}`);
  const patch = (next: Partial<OptionDraft>) => onChange({ ...option, ...next });
  return (
    <li className="rg-option">
      <label>
        <span>Option</span>
        <input aria-label={`Option ${index + 1} name`} className="is-mono" value={option.name} disabled={disabled} spellCheck={false} aria-invalid={field('name') ? true : undefined} onChange={(event) => patch({ name: event.target.value })} />
        {field('name') && <small className="rg-error">{field('name')}</small>}
      </label>
      {option.type === 'fixed' ? (
        <div className="rg-fixed">
          <span>Fixed in the manifest</span>
          <code>{JSON.stringify(option.rest)}</code>
        </div>
      ) : (
        <>
          <label>
            <span>Type</span>
            <select aria-label={`Option ${index + 1} type`} value={option.type} disabled={disabled} onChange={(event) => patch({ type: event.target.value as OptionType })}>
              {OPTION_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select>
          </label>
          {numeric && (
            <>
              <label>
                <span>Minimum</span>
                <input aria-label={`Option ${index + 1} minimum`} className="is-mono" inputMode="decimal" value={option.minimum} disabled={disabled} aria-invalid={field('minimum') ? true : undefined} onChange={(event) => patch({ minimum: event.target.value })} />
                {field('minimum') && <small className="rg-error">{field('minimum')}</small>}
              </label>
              <label>
                <span>Maximum</span>
                <input aria-label={`Option ${index + 1} maximum`} className="is-mono" inputMode="decimal" value={option.maximum} disabled={disabled} aria-invalid={field('maximum') ? true : undefined} onChange={(event) => patch({ maximum: event.target.value })} />
                {field('maximum') && <small className="rg-error">{field('maximum')}</small>}
              </label>
            </>
          )}
          <label>
            <span>Default</span>
            <input aria-label={`Option ${index + 1} default`} className="is-mono" value={option.default} disabled={disabled} aria-invalid={field('default') ? true : undefined} onChange={(event) => patch({ default: event.target.value })} />
            {field('default') && <small className="rg-error">{field('default')}</small>}
          </label>
        </>
      )}
      <div className="rg-option-tail">
        <label className="rg-check">
          <input type="checkbox" checked={option.required} disabled={disabled} onChange={(event) => patch({ required: event.target.checked })} />
          <span>Required</span>
        </label>
        <Action size="sm" variant="ghost" disabled={disabled} aria-label={`Remove option ${option.name || index + 1}`} onClick={onRemove}>Remove</Action>
      </div>
    </li>
  );
}

function ModeEditor({ mode, index, vocabularies, issues, locked, canRemove, onChange, onRemove }: {
  mode: ModeDraft;
  index: number;
  vocabularies: Vocabulary[];
  issues: Issue[];
  locked: boolean;
  canRemove: boolean;
  onChange: (mode: ModeDraft) => void;
  onRemove: () => void;
}) {
  const at = `modes.${index}`;
  const vocabulary = vocabularyFor(vocabularies, mode.profile);
  const dimension = (id: string) => vocabulary.dimensions.find((item) => item.id === id);
  const placement = dimension('placement');
  const featureValues = dimension('featureValues');
  const others = vocabulary.dimensions.filter((item) => !['placement', 'featureValues', 'scalarizations'].includes(item.id));
  const patch = (next: Partial<ModeDraft>) => onChange({ ...mode, ...next });
  const setChoice = (id: string, choice: Choice) => patch({ capabilities: { ...mode.capabilities, [id]: choice } });
  const presetIds: string[] = SCALARIZATIONS.map((item) => item.id);
  const custom = mode.scalarizations.filter((item) => !presetIds.includes(item.id));
  const toggleScalarization = (id: string) => {
    const preset = SCALARIZATIONS.find((item) => item.id === id);
    if (!preset) return;
    const has = mode.scalarizations.some((item) => item.id === id);
    patch({
      scalarizations: has
        ? mode.scalarizations.filter((item) => item.id !== id)
        : [...mode.scalarizations, { id: preset.id, objectiveTypes: preset.objectiveTypes, weightPolicy: preset.weightPolicy }],
    });
  };
  const toggleTermination = (id: string) => patch({ termination: ALL_TERMINATIONS.filter((item) => (item === id ? !mode.termination.includes(item) : mode.termination.includes(item))) });
  const termination: ReadonlyArray<Option<Termination>> = [
    { id: 'OPTIMAL', label: 'Optimal' },
    { id: 'FEASIBLE', label: 'Feasible' },
    { id: 'INFEASIBLE', label: 'Infeasible' },
    { id: 'UNKNOWN', label: 'No conclusion' },
  ];
  const customized = others.filter((item) => {
    const choice = mode.capabilities[item.id];
    return choice && choice.selector !== (item.open ? 'none' : 'all');
  }).length;

  return (
    <section className="rg-mode" aria-label={`Mode ${index + 1}`}>
      <header>
        <div className="rg-mode-title">
          <strong>Mode</strong>
          <StatusChip>{mode.id || 'unnamed'}</StatusChip>
          <span>One way of solving. An engine can offer several.</span>
        </div>
        {canRemove && !locked && <Action size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove mode ${mode.id || index + 1}`}>Remove mode</Action>}
      </header>

      <div className="rg-grid">
        <FormField label="Mode name" mono value={mode.id} disabled={locked} spellCheck={false} error={issueAt(issues, `${at}.id`)} onChange={(event) => patch({ id: event.target.value })} />
        <FormField label="Algorithm" value={mode.algorithm} disabled={locked} placeholder="Tabu search" error={issueAt(issues, `${at}.algorithm`)} hint="What it runs. It doesn’t promise a guarantee." onChange={(event) => patch({ algorithm: event.target.value })} />
        {vocabularies.length > 1 ? (
          <div className="ui-field">
            <label htmlFor={`${mode.key}-profile`}>Language profile</label>
            <select id={`${mode.key}-profile`} value={mode.profile} disabled={locked} onChange={(event) => {
              const next = newMode(vocabularyFor(vocabularies, event.target.value), mode.id);
              onChange({ ...next, key: mode.key, algorithm: mode.algorithm });
            }}>
              {vocabularies.map((item) => <option key={item.profile} value={item.profile}>{item.profile}</option>)}
            </select>
          </div>
        ) : (
          <div className="rg-static">
            <span>Language profile</span>
            <strong className="is-mono">{vocabulary.profile}</strong>
          </div>
        )}
        <div className="rg-static">
          <span>Reads problems as</span>
          <strong>{vocabulary.ir.kind}</strong>
        </div>
      </div>

      {placement && mode.capabilities.placement && (
        <div className="rg-block">
          <div className="rg-field-label">Handles placement (where tasks may run)</div>
          <Segmented label="Placement" options={PLACEMENT_LABELS} value={mode.capabilities.placement.selector} disabled={locked} onChange={(selector) => setChoice('placement', { selector, values: selector === 'only' ? mode.capabilities.placement.values : [] })} />
          {mode.capabilities.placement.selector === 'only' && (
            <Chips label="Placement values" options={placement.values.map((value) => ({ id: value, label: value }))} selected={mode.capabilities.placement.values} disabled={locked} onToggle={(id) => setChoice('placement', { selector: 'only', values: toggled(mode.capabilities.placement.values, id) })} />
          )}
          {issueAt(issues, `${at}.capabilities.placement`) && <span className="rg-error" role="alert">{issueAt(issues, `${at}.capabilities.placement`)}</span>}
        </div>
      )}

      {featureValues && mode.capabilities.featureValues && (
        <FeatureValuesEditor choice={mode.capabilities.featureValues} disabled={locked} onChange={(choice) => setChoice('featureValues', choice)} />
      )}

      <div className="rg-block">
        <div className="rg-field-label">How objectives are scalarized</div>
        <Chips
          label="Objective scalarizations"
          options={SCALARIZATIONS.map((item) => ({ id: item.id, label: item.label }))}
          selected={mode.scalarizations.map((item) => item.id)}
          disabled={locked}
          onToggle={toggleScalarization}
        />
        {custom.length > 0 && <small className="eng-muted">Also declared in the manifest: {custom.map((item) => item.id).join(', ')}.</small>}
        {issueAt(issues, `${at}.scalarizations`) && <span className="rg-error" role="alert">{issueAt(issues, `${at}.scalarizations`)}</span>}
      </div>

      <div className="rg-block">
        <div className="rg-field-label">How a run can end <span>(pick at least one)</span></div>
        <Chips label="Possible outcomes" options={termination} selected={mode.termination} disabled={locked} onToggle={toggleTermination} />
        {issueAt(issues, `${at}.termination`) && <span className="rg-error" role="alert">{issueAt(issues, `${at}.termination`)}</span>}
        <div className="rg-checks">
          <label className="rg-check"><input type="checkbox" checked={mode.exact} disabled={locked} onChange={(event) => patch({ exact: event.target.checked })} /><span>It’s exact: when it says optimal, it is</span></label>
          <label className="rg-check"><input type="checkbox" checked={mode.deterministic} disabled={locked} onChange={(event) => patch({ deterministic: event.target.checked })} /><span>Same answer every time when it has no time limit</span></label>
          <label className="rg-check"><input type="checkbox" checked={mode.completePareto} disabled={locked} onChange={(event) => patch({ completePareto: event.target.checked })} /><span>It returns the complete Pareto front</span></label>
        </div>
      </div>

      <div className="rg-block">
        <div className="rg-field-label">Options people can set</div>
        {mode.options.length === 0 && <small className="eng-muted">This mode takes no caller options.</small>}
        <ul className="rg-options" aria-label={`Options of mode ${mode.id || index + 1}`}>
          {mode.options.map((option, optionIndex) => (
            <OptionRow
              key={option.key}
              option={option}
              index={optionIndex}
              disabled={locked}
              issues={issues}
              at={`${at}.options.${optionIndex}`}
              onChange={(next) => patch({ options: mode.options.map((item) => (item.key === option.key ? next : item)) })}
              onRemove={() => patch({ options: mode.options.filter((item) => item.key !== option.key) })}
            />
          ))}
        </ul>
        {!locked && <Action size="sm" variant="secondary" className="rg-self-start" onClick={() => patch({ options: [...mode.options, newOption()] })}>Add an option</Action>}
      </div>

      <div className="rg-block">
        <div className="rg-field-label">Ceilings it declares <span>(at least one)</span></div>
        <div className="rg-limits">
          {vocabulary.limits.map((name) => (
            <label key={name}>
              <span className="is-mono">{name}</span>
              <input aria-label={`Ceiling ${name}`} className="is-mono" inputMode="numeric" value={mode.limits[name] ?? ''} disabled={locked} aria-invalid={issueAt(issues, `${at}.limits.${name}`) ? true : undefined} onChange={(event) => patch({ limits: { ...mode.limits, [name]: event.target.value } })} />
              {issueAt(issues, `${at}.limits.${name}`) && <small className="rg-error">{issueAt(issues, `${at}.limits.${name}`)}</small>}
            </label>
          ))}
        </div>
        {issueAt(issues, `${at}.limits`) && <span className="rg-error" role="alert">{issueAt(issues, `${at}.limits`)}</span>}
      </div>

      <details className="rg-more">
        <summary>Other capabilities <span>{customized === 0 ? `${others.length} dimensions · everything the profile defines` : `${customized} of ${others.length} changed`}</span></summary>
        <p className="eng-muted">Every dimension of the profile has to be named. Choose nothing, everything, or the exact values this mode handles.</p>
        {others.map((item) => mode.capabilities[item.id] && (
          <CapabilityRow
            key={item.id}
            dimension={item}
            choice={mode.capabilities[item.id]}
            disabled={locked}
            error={issueAt(issues, `${at}.capabilities.${item.id}`)}
            onChange={(choice) => setChoice(item.id, choice)}
          />
        ))}
      </details>
    </section>
  );
}

interface EngineFormProps {
  draft: EngineDraft;
  onChange: (draft: EngineDraft) => void;
  vocabularies: Vocabulary[];
  issues: Issue[];
  locked: boolean;
  namespace: string;
}

/** The engine as fields: identity, then each mode with what it can solve. The manifest is built from these, never typed. */
export function EngineForm({ draft, onChange, vocabularies, issues, locked, namespace }: EngineFormProps) {
  const primary = vocabularies[0];
  return (
    <div className="rg-form">
      <div className="rg-grid">
        <div className="rg-static">
          <span>Namespace</span>
          <strong className="is-mono">{namespace} <StatusChip tone="info">yours</StatusChip></strong>
        </div>
        <FormField label="Name" mono value={draft.name} disabled={locked} spellCheck={false} error={issueAt(issues, 'name')} hint="Letters, digits, dots, dashes, underscores." hintTone="neutral" onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        <FormField label="Version" mono value={draft.version} disabled={locked} spellCheck={false} error={issueAt(issues, 'version')} hint="Three numbers, like 1.0.0. Fixed once created." onChange={(event) => onChange({ ...draft, version: event.target.value })} />
      </div>
      <FormField label="Description (optional)" value={draft.description} disabled={locked} placeholder="A short note on what it is for" onChange={(event) => onChange({ ...draft, description: event.target.value })} />

      {draft.modes.map((mode, index) => (
        <ModeEditor
          key={mode.key}
          mode={mode}
          index={index}
          vocabularies={vocabularies}
          issues={issues}
          locked={locked}
          canRemove={draft.modes.length > 1}
          onChange={(next) => onChange({ ...draft, modes: draft.modes.map((item) => (item.key === mode.key ? next : item)) })}
          onRemove={() => onChange({ ...draft, modes: draft.modes.filter((item) => item.key !== mode.key) })}
        />
      ))}
      {issueAt(issues, 'modes') && <span className="rg-error" role="alert">{issueAt(issues, 'modes')}</span>}
      {!locked && primary && (
        <Action variant="secondary" className="rg-self-start" onClick={() => onChange({ ...draft, modes: [...draft.modes, newMode(primary, `mode-${draft.modes.length + 1}`)] })}>
          Add another mode
        </Action>
      )}
    </div>
  );
}
