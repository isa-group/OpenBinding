import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { candidateMatrix } from '../../../core/utils/binding/candidateMatrix';
import { workflowGraph, type TaskOverlay } from '../../../core/utils/binding/workflowGraph';
import { documentValue, readDocument, type Kind } from '../../../core/utils/composition/document';
import { KIND_OPTIONS } from '../../../core/utils/composition/kinds';
import type { ProblemFacts } from '../../../core/api/types';
import { CandidateMatrix } from '../../../core/components/candidate-matrix/CandidateMatrix';
import { WorkflowGraph } from '../../../core/components/workflow-graph/WorkflowGraph';
import {
  offeringChoice,
  removeValue,
  setCandidate,
  setKind,
  setOffering,
  setValue,
  setVersion,
  type DocumentModel,
  type OfferingChoice,
} from './mutations';

type Mutate = (
  change: (document: DocumentModel) => DocumentModel
) => Promise<{ ok: true } | { ok: false; message: string }>;

interface VisualPaneProps {
  document: DocumentModel | null;
  /** Why the document could not be read (not a finding about the text: those are in the Problems panel). */
  issue: string | null;
  facts: ProblemFacts | null;
  mutate: Mutate;
  busy: boolean;
  readOnly: boolean;
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ce-part" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** A small form of one field and a button: the change is made when it is submitted. */
function FieldForm({
  label,
  initial,
  button,
  onSubmit,
  disabled,
  placeholder,
}: {
  label: string;
  initial: string;
  button: string;
  onSubmit: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="ce-inline" onSubmit={submit}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="ce-input"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        onChange={event => setValue(event.target.value)}
      />
      <Action
        type="submit"
        size="sm"
        disabled={disabled || !value.trim() || value.trim() === initial}
      >
        {button}
      </Action>
    </form>
  );
}

function ValueRow({
  name,
  value,
  unit,
  disabled,
  onSet,
  onRemove,
}: {
  name: string;
  value: number;
  unit: string;
  disabled: boolean;
  onSet: (value: number, unit: string) => void;
  onRemove: () => void;
}) {
  const [number, setNumber] = useState(String(value));
  const [written, setWritten] = useState(unit === '1' ? '' : unit);
  const parsed = Number(number);
  const valid = number.trim() !== '' && Number.isFinite(parsed);
  return (
    <form
      className="ce-value"
      aria-label={`Value ${name}`}
      onSubmit={event => {
        event.preventDefault();
        if (valid) onSet(parsed, written);
      }}
    >
      <code className="ce-value-name">{name}</code>
      <label className="sr-only" htmlFor={`ce-v-${name}`}>{`${name} value`}</label>
      <input
        id={`ce-v-${name}`}
        className="ce-input"
        inputMode="decimal"
        value={number}
        disabled={disabled}
        onChange={event => setNumber(event.target.value)}
      />
      <label className="sr-only" htmlFor={`ce-u-${name}`}>{`${name} unit`}</label>
      <input
        id={`ce-u-${name}`}
        className="ce-input"
        value={written}
        placeholder="unit"
        disabled={disabled}
        onChange={event => setWritten(event.target.value)}
      />
      <Action type="submit" size="sm" disabled={disabled || !valid}>
        Set
      </Action>
      <Action size="sm" variant="ghost" disabled={disabled} onClick={onRemove}>
        Remove
      </Action>
    </form>
  );
}

function NewValue({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (name: string, value: number, unit: string) => void;
}) {
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [unit, setUnit] = useState('');
  const parsed = Number(number);
  const valid = name.trim() !== '' && number.trim() !== '' && Number.isFinite(parsed);
  return (
    <form
      className="ce-value"
      aria-label="New value"
      onSubmit={event => {
        event.preventDefault();
        if (!valid) return;
        onAdd(name.trim(), parsed, unit);
        setName('');
        setNumber('');
        setUnit('');
      }}
    >
      <label className="sr-only" htmlFor="ce-new-name">
        New value name
      </label>
      <input
        id="ce-new-name"
        className="ce-input"
        placeholder="name"
        value={name}
        disabled={disabled}
        spellCheck={false}
        onChange={event => setName(event.target.value)}
      />
      <label className="sr-only" htmlFor="ce-new-value">
        New value
      </label>
      <input
        id="ce-new-value"
        className="ce-input"
        inputMode="decimal"
        placeholder="value"
        value={number}
        disabled={disabled}
        onChange={event => setNumber(event.target.value)}
      />
      <label className="sr-only" htmlFor="ce-new-unit">
        New value unit
      </label>
      <input
        id="ce-new-unit"
        className="ce-input"
        placeholder="unit"
        value={unit}
        disabled={disabled}
        onChange={event => setUnit(event.target.value)}
      />
      <Action type="submit" size="sm" disabled={disabled || !valid}>
        Add value
      </Action>
    </form>
  );
}

const OFFERING_FORMS: Array<{ id: 'none' | OfferingChoice['source']; label: string }> = [
  { id: 'none', label: 'No offering' },
  { id: 'sphere', label: 'A SPHERE pricing' },
  { id: 'registry', label: 'A SPHERE pricing on a registry' },
  { id: 'url', label: 'A Pricing2Yaml file (URL)' },
];

function OfferingForm({
  current,
  disabled,
  onSet,
}: {
  current: OfferingChoice | null;
  disabled: boolean;
  onSet: (offering: OfferingChoice | null) => void;
}) {
  const [form, setForm] = useState<'none' | OfferingChoice['source']>(current?.source ?? 'none');
  const [sphere, setSphere] = useState(current && current.source !== 'url' ? current.sphere : '');
  const [registry, setRegistry] = useState(current?.source === 'registry' ? current.registry : '');
  const [url, setUrl] = useState(current?.source === 'url' ? current.url : '');
  const choice: OfferingChoice | null | undefined =
    form === 'none'
      ? null
      : form === 'url'
        ? url.trim()
          ? { source: 'url', url: url.trim() }
          : undefined
        : form === 'registry'
          ? sphere.trim() && registry.trim()
            ? { source: 'registry', sphere: sphere.trim(), registry: registry.trim() }
            : undefined
          : sphere.trim()
            ? { source: 'sphere', sphere: sphere.trim() }
            : undefined;
  return (
    <form
      className="ce-offering"
      onSubmit={event => {
        event.preventDefault();
        if (choice !== undefined) onSet(choice);
      }}
    >
      <div className="ui-field">
        <label htmlFor="ce-offering-form">Source</label>
        <select
          id="ce-offering-form"
          className="cmp-select"
          value={form}
          disabled={disabled}
          onChange={event => setForm(event.target.value as typeof form)}
        >
          {OFFERING_FORMS.map(option => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {(form === 'sphere' || form === 'registry') && (
        <div className="ui-field">
          <label htmlFor="ce-offering-sphere">SPHERE pricing (owner/name)</label>
          <input
            id="ce-offering-sphere"
            className="ce-input"
            value={sphere}
            disabled={disabled}
            spellCheck={false}
            onChange={event => setSphere(event.target.value)}
          />
        </div>
      )}
      {form === 'registry' && (
        <div className="ui-field">
          <label htmlFor="ce-offering-registry">Registry alias</label>
          <input
            id="ce-offering-registry"
            className="ce-input"
            value={registry}
            disabled={disabled}
            spellCheck={false}
            onChange={event => setRegistry(event.target.value)}
          />
        </div>
      )}
      {form === 'url' && (
        <div className="ui-field">
          <label htmlFor="ce-offering-url">Pricing2Yaml URL</label>
          <input
            id="ce-offering-url"
            className="ce-input"
            type="url"
            value={url}
            disabled={disabled}
            spellCheck={false}
            onChange={event => setUrl(event.target.value)}
          />
        </div>
      )}
      <div>
        <Action type="submit" size="sm" disabled={disabled || choice === undefined}>
          Set the offering
        </Action>
      </div>
    </form>
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The visual editor: the document as the gateway reads it, with the changes the language lets a person choose (the label and
 * kind, each task's candidate, declared values, the offering). Each change goes through the gateway's parse and serialise and
 * replaces the draft as one undo step. The workflow is shown, not edited.
 */
export function VisualPane({ document, issue, facts, mutate, busy, readOnly }: VisualPaneProps) {
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const disabled = readOnly || busy;

  if (issue) return <Notice tone="error">{issue}</Notice>;
  if (!document) {
    return (
      <p className="cmp-muted" role="status">
        The visual editor shows a document the gateway can read. Fix the problems in the code to use
        it.
      </p>
    );
  }

  const apply = async (
    change: (model: DocumentModel) => DocumentModel,
    after: string | null = null
  ) => {
    setFailure(null);
    const done = await mutate(change);
    if (done.ok) setNote(after);
    else setFailure(done.message);
  };

  const typed = readDocument(document);
  const graph = workflowGraph(document.workflow ?? null);
  const binding = isRecord(document.binding) ? document.binding : {};
  const linked = isRecord(document.problem);
  const tasks = [
    ...graph.tasks,
    ...Object.keys(binding).filter(task => !graph.tasks.includes(task)),
  ];
  const overlay = Object.fromEntries(
    tasks.map((task): [string, TaskOverlay] => {
      const entry = binding[task];
      return [
        task,
        isRecord(entry) && entry.local === true
          ? { local: true }
          : isRecord(entry) && typeof entry.candidate === 'string'
            ? { candidate: entry.candidate }
            : {},
      ];
    })
  );
  const values = Object.entries(typed?.values ?? {}).map(([name, value]) => ({
    name,
    ...documentValue(value),
  }));
  const label = typeof document.version === 'string' ? document.version : '';
  const kind = typeof document.kind === 'string' ? document.kind : '';

  const writtenToKey = (task: string, written: string | undefined) =>
    facts?.tasks.find(item => item.id === task)?.eligible.find(item => item.written === written)
      ?.candidate;
  const selection: Record<string, string> = {};
  for (const task of tasks) {
    const entry = binding[task];
    const key =
      isRecord(entry) && typeof entry.candidate === 'string'
        ? writtenToKey(task, entry.candidate)
        : undefined;
    if (key) selection[task] = key;
  }
  const matrix = facts ? candidateMatrix(facts, { selection }) : null;

  const chooseCandidate = (task: string, candidate: string) => {
    let dropped: string | null = null;
    void apply(model => {
      const changed = setCandidate(model, task, candidate);
      dropped = changed.note;
      return changed.document;
    }).then(() => {
      if (dropped) setNote(`${task}: ${dropped}`);
    });
  };

  // The offering form starts again from the document whenever the offering changes in it.
  const offeringKey = JSON.stringify(document.offering ?? null);
  return (
    <div className="ce-visual">
      {linked && (
        <p className="cmp-muted">
          This version links a problem: values are recomputed when you seal.
        </p>
      )}
      <div aria-live="polite">
        {note && (
          <p className="ce-note" role="status">
            {note}
          </p>
        )}
        {failure && <Notice tone="error">{failure}</Notice>}
      </div>

      <Part title="Identity">
        <FieldForm
          key={`version-${label}`}
          label="Version"
          initial={label}
          button="Set version"
          disabled={disabled}
          onSubmit={next => void apply(model => setVersion(model, next))}
        />
        <div className="ce-inline">
          <label htmlFor="ce-kind">Kind</label>
          <select
            id="ce-kind"
            className="cmp-select"
            value={kind}
            disabled={disabled}
            onChange={event => void apply(model => setKind(model, event.target.value as Kind))}
          >
            {KIND_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </Part>

      <Part title="Workflow">
        <p className="cmp-muted">The workflow is edited in the code, as the problem writes it.</p>
        <WorkflowGraph graph={graph} overlay={overlay} label="The workflow of this draft" />
      </Part>

      <Part title="Binding">
        <ul className="ce-tasks">
          {tasks.map(task => {
            const entry = binding[task];
            const local = isRecord(entry) && entry.local === true;
            const written =
              isRecord(entry) && typeof entry.candidate === 'string' ? entry.candidate : '';
            const row = matrix?.rows.find(item => item.task === task);
            return (
              <li key={task} className="ce-task">
                <code className="ce-task-name">{task}</code>
                {local ? (
                  <span className="cmp-muted">Done in house</span>
                ) : row && row.candidates.length ? (
                  <CandidateMatrix
                    matrix={{ features: matrix?.features ?? [], rows: [row] }}
                    mode={disabled ? 'view' : 'select'}
                    onSelect={(chosen, key) =>
                      chooseCandidate(
                        chosen,
                        row.candidates.find(item => item.key === key)?.written ?? key
                      )
                    }
                    label={`Candidates for ${task}`}
                  />
                ) : (
                  <FieldForm
                    key={`${task}-${written}`}
                    label={`Candidate for ${task}`}
                    initial={written}
                    button="Set candidate"
                    disabled={disabled}
                    onSubmit={next => chooseCandidate(task, next)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </Part>

      <Part title="Values">
        {linked && (
          <p className="cmp-muted">The gateway replaces these with the values it computes.</p>
        )}
        {values.map(value => (
          <ValueRow
            key={`${value.name}-${value.value}-${value.unit}`}
            name={value.name}
            value={value.value}
            unit={value.unit}
            disabled={disabled}
            onSet={(number, unit) => void apply(model => setValue(model, value.name, number, unit))}
            onRemove={() => void apply(model => removeValue(model, value.name))}
          />
        ))}
        <NewValue
          disabled={disabled}
          onAdd={(name, number, unit) => void apply(model => setValue(model, name, number, unit))}
        />
      </Part>

      <Part title="Offering">
        <OfferingForm
          key={offeringKey}
          current={offeringChoice(document)}
          disabled={disabled}
          onSet={offering => void apply(model => setOffering(model, offering))}
        />
      </Part>
    </div>
  );
}
