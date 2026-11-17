// The visual pane of the composition editor: OpenBinding's per-task candidate selector, kind, label, values and offering over
// the document as the gateway parses it, each change written back through parse and serialise (utils/mutations). Its parts
// are drawn as SPHERE's visual editor draws its side panels (rounded cards on the surface); no SPHERE code is copied.

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
} from '../../utils/mutations';

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
    <section
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas px-4 py-3 shadow-sm [&_h3]:m-0 [&_h3]:text-[11px] [&_h3]:font-bold [&_h3]:tracking-[0.12em] [&_h3]:text-tp-slate [&_h3]:uppercase"
      aria-labelledby={id}
    >
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
    <form
      className="flex flex-wrap items-center gap-2 [&_label]:text-[13px] [&_label]:text-tp-steel"
      onSubmit={submit}
    >
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
      className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(80px,1fr)_minmax(70px,1fr)_minmax(70px,1fr)_auto_auto]"
      aria-label={`Value ${name}`}
      onSubmit={event => {
        event.preventDefault();
        if (valid) onSet(parsed, written);
      }}
    >
      <code className="col-span-full font-mono text-[13px] [overflow-wrap:anywhere] sm:col-span-1">
        {name}
      </code>
      <label className="sr-only" htmlFor={`ce-v-${name}`}>{`${name} value`}</label>
      <input
        id={`ce-v-${name}`}
        className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
        inputMode="decimal"
        value={number}
        disabled={disabled}
        onChange={event => setNumber(event.target.value)}
      />
      <label className="sr-only" htmlFor={`ce-u-${name}`}>{`${name} unit`}</label>
      <input
        id={`ce-u-${name}`}
        className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
      className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(80px,1fr)_minmax(70px,1fr)_minmax(70px,1fr)_auto_auto]"
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
        className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
        className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
        className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault();
        if (choice !== undefined) onSet(choice);
      }}
    >
      <div className="ui-field">
        <label htmlFor="ce-offering-form">Source</label>
        <select
          id="ce-offering-form"
          className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
            className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
            className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
            className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
export default function VisualPane({
  document,
  issue,
  facts,
  mutate,
  busy,
  readOnly,
}: VisualPaneProps) {
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const disabled = readOnly || busy;

  if (issue) return <Notice tone="error">{issue}</Notice>;
  if (!document) {
    return (
      <p className="text-sm text-tp-steel" role="status">
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
    <div className="flex min-w-0 flex-col gap-4">
      {linked && (
        <p className="text-sm text-tp-steel">
          This version links a problem: values are recomputed when you seal.
        </p>
      )}
      <div aria-live="polite">
        {note && (
          <p className="m-0 text-[13px] text-tp-slate" role="status">
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
        <div className="flex flex-wrap items-center gap-2 [&_label]:text-[13px] [&_label]:text-tp-steel">
          <label htmlFor="ce-kind">Kind</label>
          <select
            id="ce-kind"
            className="h-8 min-w-0 rounded-md border border-tp-hairline-strong bg-tp-canvas px-2 text-sm text-tp-ink outline-none focus-visible:ring-2 focus-visible:ring-tp-accent/30"
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
        <p className="text-sm text-tp-steel">
          The workflow is edited in the code, as the problem writes it.
        </p>
        <WorkflowGraph graph={graph} overlay={overlay} label="The workflow of this draft" />
      </Part>

      <Part title="Binding">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {tasks.map(task => {
            const entry = binding[task];
            const local = isRecord(entry) && entry.local === true;
            const written =
              isRecord(entry) && typeof entry.candidate === 'string' ? entry.candidate : '';
            const row = matrix?.rows.find(item => item.task === task);
            return (
              <li key={task} className="flex min-w-0 flex-col gap-1">
                <code className="font-mono text-[13px] [overflow-wrap:anywhere]">{task}</code>
                {local ? (
                  <span className="text-sm text-tp-steel">Done in house</span>
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
          <p className="text-sm text-tp-steel">
            The gateway replaces these with the values it computes.
          </p>
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
