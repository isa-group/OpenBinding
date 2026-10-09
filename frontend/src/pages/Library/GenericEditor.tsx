import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { RefLine } from './ContentView';
import {
  defaultOf, isCaseRevisionRef, isObject, isVersionRef, labelOf, NODE_TYPES, typeOf, updateAt,
  type Json, type JsonObject, type NodeType,
} from './contentModel';
import { NumberField, TextField } from './fields';

type Path = Array<string | number>;

interface Ctx {
  readOnly: boolean;
  set: (path: Path, value: Json | undefined) => void;
}

/** The two fields that say what a resource is are shown and never edited: changing them would make it a different thing. */
const LOCKED_AT_ROOT = new Set(['apiVersion', 'kind']);

function AddEntry({ onAdd, taken, defaultType = 'text', keyed }: { onAdd: (name: string, type: NodeType) => void; taken: string[]; defaultType?: NodeType; keyed: boolean }) {
  const id = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<NodeType>(defaultType);
  const [error, setError] = useState('');

  const add = () => {
    const trimmed = name.trim();
    if (keyed && !trimmed) {
      setError('Give the new field a name.');
      return;
    }
    if (keyed && taken.includes(trimmed)) {
      setError(`There is already a field called “${trimmed}”.`);
      return;
    }
    onAdd(trimmed, type);
    setName('');
    setError('');
  };

  return (
    <div className="lib-add">
      {keyed && (
        <div className="ui-field">
          <label htmlFor={`${id}-name`}>New field name</label>
          <input id={`${id}-name`} value={name} spellCheck={false} autoComplete="off" onChange={(event) => { setName(event.target.value); setError(''); }} aria-invalid={error ? true : undefined} />
        </div>
      )}
      <div className="ui-field">
        <label htmlFor={`${id}-type`}>{keyed ? 'Holds' : 'Item type'}</label>
        <select id={`${id}-type`} value={type} onChange={(event) => setType(event.target.value as NodeType)}>
          {NODE_TYPES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </div>
      <Action variant="secondary" size="sm" onClick={add}><Plus aria-hidden="true" className="org-inline-icon" />{keyed ? 'Add field' : 'Add item'}</Action>
      {error && <span className="ui-field-note is-error" role="alert">{error}</span>}
    </div>
  );
}

function RemoveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="lib-remove" onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      <X aria-hidden="true" />
    </button>
  );
}

interface NodeProps {
  name: string;
  value: Json;
  path: Path;
  ctx: Ctx;
  locked?: boolean;
  /** What removing it is called for people using a screen reader (`Remove field tasks`). */
  removeLabel?: string;
}

function Leaf({ name, value, path, ctx, locked, removeLabel }: NodeProps) {
  const id = useId();
  const label = typeof path[path.length - 1] === 'number' ? `Item ${(path[path.length - 1] as number) + 1}` : labelOf(name);
  const disabled = ctx.readOnly || locked;
  let control;
  if (typeof value === 'number') {
    control = <NumberField id={id} label={label} value={value} disabled={disabled} onChange={(next) => ctx.set(path, next ?? 0)} />;
  } else if (typeof value === 'boolean') {
    control = (
      <label className="lib-check">
        <input id={id} type="checkbox" checked={value} disabled={disabled} onChange={(event) => ctx.set(path, event.target.checked)} />
        {value ? 'Yes' : 'No'}
      </label>
    );
  } else if (value === null) {
    control = <Action variant="secondary" size="sm" disabled={disabled} onClick={() => ctx.set(path, '')}>Set a value</Action>;
  } else if (typeof value === 'string' && (value.includes('\n') || value.length > 90)) {
    control = <textarea id={id} className="proj-textarea" rows={4} value={value} disabled={disabled} spellCheck={false} onChange={(event) => ctx.set(path, event.target.value)} />;
  } else {
    control = <TextField id={id} label={label} value={String(value)} disabled={disabled} onChange={(next) => ctx.set(path, next)} />;
  }
  return (
    <div className="lib-leaf">
      <label htmlFor={id}>{label}{labelOf(name) !== name && typeof path[path.length - 1] === 'string' && <code>{name}</code>}</label>
      <div className="lib-leaf-control">{control}</div>
      {removeLabel && !locked && <RemoveButton label={removeLabel} disabled={ctx.readOnly} onClick={() => ctx.set(path, undefined)} />}
    </div>
  );
}

function Reference({ name, value, path, ctx, locked, removeLabel }: NodeProps) {
  return (
    <div className="lib-leaf">
      <span className="lib-leaf-name">{typeof path[path.length - 1] === 'number' ? `Item ${(path[path.length - 1] as number) + 1}` : labelOf(name)}</span>
      <div className="lib-leaf-control">
        {isVersionRef(value) ? <RefLine value={value} /> : <span className="lib-text">{isCaseRevisionRef(value) ? `Case revision ${value.caseRevisionId}` : ''}</span>}
      </div>
      {removeLabel && !locked && <RemoveButton label={removeLabel} disabled={ctx.readOnly} onClick={() => ctx.set(path, undefined)} />}
    </div>
  );
}

function Group({ name, value, path, ctx, locked, removeLabel, root }: NodeProps & { value: JsonObject; root?: boolean }) {
  const entries = Object.entries(value);
  const body = (
    <>
      {entries.length === 0 && <p className="lib-empty-note">Nothing here yet.</p>}
      {entries.map(([key, child]) => (
        <EditorNode
          key={key}
          name={key}
          value={child}
          path={[...path, key]}
          ctx={ctx}
          locked={root && LOCKED_AT_ROOT.has(key)}
          removeLabel={`Remove ${labelOf(key)}${labelOf(key) !== key ? '' : ' field'}`}
        />
      ))}
      {!ctx.readOnly && !locked && (
        <AddEntry keyed taken={Object.keys(value)} onAdd={(entry, type) => ctx.set([...path, entry], defaultOf(type))} />
      )}
    </>
  );
  if (root) return <div className="lib-group is-root">{body}</div>;
  return (
    <fieldset className="lib-group">
      <legend>{labelOf(name)}{labelOf(name) !== name && <code>{name}</code>}</legend>
      {removeLabel && !locked && <RemoveButton label={removeLabel} disabled={ctx.readOnly} onClick={() => ctx.set(path, undefined)} />}
      {body}
    </fieldset>
  );
}

function List({ name, value, path, ctx, locked, removeLabel }: NodeProps & { value: Json[] }) {
  return (
    <fieldset className="lib-group is-list">
      <legend>{labelOf(name)}{labelOf(name) !== name && <code>{name}</code>}<span className="lib-count">{value.length}</span></legend>
      {removeLabel && !locked && <RemoveButton label={removeLabel} disabled={ctx.readOnly} onClick={() => ctx.set(path, undefined)} />}
      {value.length === 0 && <p className="lib-empty-note">No items yet.</p>}
      {value.map((item, index) => (
        <EditorNode key={index} name={`Item ${index + 1}`} value={item} path={[...path, index]} ctx={ctx} removeLabel={`Remove item ${index + 1} of ${labelOf(name)}`} />
      ))}
      {!ctx.readOnly && !locked && (
        <AddEntry keyed={false} taken={[]} defaultType={value.length ? typeOf(value[0]) : 'text'} onAdd={(_, type) => ctx.set([...path, value.length], defaultOf(type))} />
      )}
    </fieldset>
  );
}

function EditorNode(props: NodeProps) {
  const { value } = props;
  if (isVersionRef(value) || isCaseRevisionRef(value)) return <Reference {...props} />;
  if (Array.isArray(value)) return <List {...props} value={value} />;
  if (isObject(value)) return <Group {...props} value={value} />;
  return <Leaf {...props} />;
}

/**
 * A document edited field by field, whatever its shape: groups hold fields, lists hold items, and text, numbers and yes/no values
 * have their own controls. It is the editor of every kind that has no table of its own, so no kind is left without a form.
 */
export function GenericEditor({ document, onChange, readOnly }: { document: JsonObject; onChange: (next: JsonObject) => void; readOnly: boolean }) {
  const ctx: Ctx = {
    readOnly,
    set: (path, value) => onChange(updateAt(document, path, value)),
  };
  return <Group name="" value={document} path={[]} ctx={ctx} root />;
}
