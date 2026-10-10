import { useId, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import {
  addCandidate, addRule, removeCandidate, removeRule, renameCandidate, renameRule, setCandidateFeature, setCandidateProvider, setRuleEnforcement,
  setRuleField, type CatalogView, type JsonObject, type RuleRow,
} from './contentModel';
import { CommitField, NumberField, TextField } from './fields';
import { FeatureCell } from './FeatureCell';
import { plural } from './libraryModel';

interface CatalogEditorProps {
  document: JsonObject;
  catalog: CatalogView;
  onChange: (next: JsonObject) => void;
  readOnly: boolean;
}

function AddOne({ label, placeholder, button, onAdd, taken }: { label: string; placeholder: string; button: string; onAdd: (name: string) => void; taken: string[] }) {
  const id = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next) {
      setError(`Give it a name.`);
      return;
    }
    if (taken.includes(next)) {
      setError(`“${next}” already exists.`);
      return;
    }
    onAdd(next);
    setName('');
    setError('');
  };
  return (
    <form className="lib-add" onSubmit={submit} noValidate>
      <div className="ui-field">
        <label htmlFor={id}>{label}</label>
        <input id={id} value={name} placeholder={placeholder} spellCheck={false} autoComplete="off" aria-invalid={error ? true : undefined} onChange={(event) => { setName(event.target.value); setError(''); }} />
      </div>
      <Action type="submit" variant="secondary" size="sm"><Plus aria-hidden="true" className="org-inline-icon" />{button}</Action>
      {error && <span className="ui-field-note is-error" role="alert">{error}</span>}
    </form>
  );
}

/** A candidate catalog as tables: one per capability, a row per candidate and a column per quality. */
export function CatalogEditor({ document, catalog, onChange, readOnly }: CatalogEditorProps) {
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [qualities, setQualities] = useState<string[]>([]);
  const columns = [...catalog.columns, ...qualities.filter((quality) => !catalog.columns.includes(quality))];
  const groups = [
    ...catalog.groups,
    ...capabilities.filter((name) => !catalog.groups.some((group) => group.capability === name)).map((capability) => ({ capability, rows: [] })),
  ];
  const everyId = catalog.groups.flatMap((group) => group.rows.map((row) => row.id));
  const blank = everyId.length === 0;

  return (
    <div className="lib-table-editor">
      {!readOnly && (
        <div className="lib-toolbar">
          <AddOne label="New capability" placeholder="e.g. service/payment" button="Add capability" taken={groups.map((group) => group.capability)} onAdd={(name) => setCapabilities([...capabilities, name])} />
          <AddOne label="New quality" placeholder="e.g. latency_ms" button="Add quality" taken={columns} onAdd={(name) => setQualities([...qualities, name])} />
        </div>
      )}
      {blank && groups.length === 0 && (
        <p className="lib-dashed">Blank draft. Name a capability (the job providers can do), then add the providers that can do it, with their measured qualities.</p>
      )}
      {groups.map((group) => (
        <section className="lib-card" key={group.capability} aria-label={`Capability ${group.capability || 'none declared'}`}>
          <header>
            <h3>Capability · {group.capability || 'none declared'}</h3>
            <span>{plural(group.rows.length, 'candidate')}</span>
          </header>
          {group.rows.length === 0 && <p className="lib-empty-note">No providers yet. Add the providers that can do this job, with their measured qualities.</p>}
          {group.rows.length > 0 && (
            <div className="lib-table-scroll">
              <table className="lib-table is-editable">
                <caption className="sr-only">Candidates for {group.capability || 'no capability'}</caption>
                <thead>
                  <tr>
                    <th scope="col">Candidate</th>
                    <th scope="col">Provider</th>
                    {columns.map((column) => <th scope="col" key={column}>{column}</th>)}
                    <th scope="col"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row, index) => (
                    <tr key={index}>
                      <td><CommitField label={`Candidate id of ${row.id}`} value={row.id} taken={everyId.filter((id) => id !== row.id)} disabled={readOnly} onCommit={(next) => onChange(renameCandidate(document, row.id, next))} /></td>
                      <td><TextField mono label={`Provider of ${row.id}`} value={row.provider} disabled={readOnly} onChange={(next) => onChange(setCandidateProvider(document, row.id, next))} /></td>
                      {columns.map((column) => (
                        <td key={column}>
                          <FeatureCell feature={column} candidate={row.id} value={row.features[column]} required disabled={readOnly} onChange={(next) => onChange(setCandidateFeature(document, row.id, column, next))} />
                        </td>
                      ))}
                      <td className="lib-cell-end"><Action variant="danger-outline" size="sm" disabled={readOnly} onClick={() => onChange(removeCandidate(document, row.id))} aria-label={`Remove ${row.id}`}>Remove</Action></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <footer>
            <Action variant="secondary" size="sm" disabled={readOnly} onClick={() => onChange(addCandidate(document, group.capability))}><Plus aria-hidden="true" className="org-inline-icon" />Add provider</Action>
            <span className="lib-footnote">Naming a provider declares it in this catalog. A quality is bound to the feature of the same name in the application.</span>
          </footer>
        </section>
      ))}
    </div>
  );
}

interface RulesEditorProps {
  document: JsonObject;
  rules: RuleRow[];
  onChange: (next: JsonObject) => void;
  readOnly: boolean;
}

/** A set of rules as a table: its name, the condition it asserts, whether it must hold or only should, and the penalty when it doesn't. */
export function RulesEditor({ document, rules, onChange, readOnly }: RulesEditorProps) {
  return (
    <section className="lib-card" aria-label="Rules">
      <header><h3>Rules</h3><span>{plural(rules.length, 'rule')}</span></header>
      {rules.length === 0 && <p className="lib-empty-note">Blank draft. Add the rules a binding has to follow.</p>}
      {rules.length > 0 && (
        <div className="lib-table-scroll">
          <table className="lib-table is-editable">
            <caption className="sr-only">Rules</caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Condition</th>
                <th scope="col">Kind</th>
                <th scope="col">Penalty</th>
                <th scope="col"><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule, index) => (
                <tr key={index}>
                  <td><CommitField label={`Rule name of ${rule.id}`} value={rule.id} taken={rules.map((other) => other.id).filter((id) => id !== rule.id)} disabled={readOnly} onCommit={(next) => onChange(renameRule(document, rule.id, next))} /></td>
                  <td className="lib-cell-wide"><TextField mono label={`Condition of ${rule.id}`} value={rule.condition} disabled={readOnly} onChange={(next) => onChange(setRuleField(document, rule.id, 'assert', next))} /></td>
                  <td>
                    <select
                      className="lib-select"
                      aria-label={`Kind of ${rule.id}`}
                      value={rule.enforcement}
                      disabled={readOnly}
                      onChange={(event) => onChange(setRuleEnforcement(document, rule.id, event.target.value === 'soft' ? 'soft' : 'hard'))}
                    >
                      <option value="hard">Must hold</option>
                      <option value="soft">Should hold</option>
                    </select>
                  </td>
                  <td><NumberField label={`Penalty of ${rule.id}`} value={rule.penalty} disabled={readOnly || rule.enforcement === 'hard'} onChange={(next) => onChange(setRuleField(document, rule.id, 'penalty', next ?? undefined))} /></td>
                  <td className="lib-cell-end"><Action variant="danger-outline" size="sm" disabled={readOnly} onClick={() => onChange(removeRule(document, rule.id))} aria-label={`Remove ${rule.id}`}>Remove</Action></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer>
        <Action variant="secondary" size="sm" disabled={readOnly} onClick={() => onChange(addRule(document))}><Plus aria-hidden="true" className="org-inline-icon" />Add rule</Action>
        <span className="lib-footnote">Renaming a rule doesn’t update the goals that refer to it. A rule that should hold needs a penalty here and an entry under penalties in the goal that goes with these rules.</span>
      </footer>
    </section>
  );
}
