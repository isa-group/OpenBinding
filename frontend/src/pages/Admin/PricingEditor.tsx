import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { humanize } from './adminModel';
import {
  HEADLINE_LIMITS, blankAddOn, booleanFeatures, limitLabel, orderedLimits, parseLimitInput,
  type AddOnEdit, type DraftEdit, type PricingDoc,
} from './pricingModel';
import './AdminPricing.css';

interface EditorProps {
  doc: PricingDoc;
  edit: DraftEdit;
  onChange: (edit: DraftEdit) => void;
  disabled?: boolean;
}

/** Plans, features and limits of a draft as forms: a figure per plan and limit, a switch per plan and feature, a card per add-on. */
export function PricingEditor({ doc, edit, onChange, disabled = false }: EditorProps) {
  const [showAll, setShowAll] = useState(false);
  const limits = orderedLimits(doc);
  const rows = showAll ? limits : limits.filter((def) => (HEADLINE_LIMITS as readonly string[]).includes(def.id));
  const features = booleanFeatures(doc);

  const setLimit = (planId: string, limitId: string, text: string) => onChange({
    ...edit,
    plans: edit.plans.map((plan) => (plan.id === planId ? { ...plan, limits: { ...plan.limits, [limitId]: text } } : plan)),
  });
  const toggleFeature = (planId: string, featureId: string) => onChange({
    ...edit,
    plans: edit.plans.map((plan) => (plan.id === planId ? { ...plan, features: { ...plan.features, [featureId]: !plan.features[featureId] } } : plan)),
  });
  const setAddOn = (index: number, next: AddOnEdit | null) => onChange({
    ...edit,
    addOns: next ? edit.addOns.map((item, position) => (position === index ? next : item)) : edit.addOns.filter((_, position) => position !== index),
  });

  return (
    <div className="apr-editor">
      <div className="ui-table-wrap" tabIndex={0} role="region" aria-label="Limits per plan">
        <table className="ui-table" style={{ minWidth: 720 }}>
          <caption className="sr-only">Limits per plan</caption>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              {edit.plans.map((plan) => <th key={plan.id} scope="col">{plan.id}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((def) => (
              <tr key={def.id}>
                <th scope="row">
                  {limitLabel(doc, def.id)}
                  {def.unit && <span className="adm-sub">{def.unit}</span>}
                </th>
                {edit.plans.map((plan) => {
                  const text = plan.limits[def.id] ?? '';
                  const bad = parseLimitInput(text) === undefined;
                  return (
                    <td key={plan.id}>
                      <input
                        className="apr-cell"
                        value={text}
                        disabled={disabled}
                        onChange={(event) => setLimit(plan.id, def.id, event.target.value)}
                        aria-label={`${limitLabel(doc, def.id)} for ${plan.id}`}
                        aria-invalid={bad || undefined}
                        spellCheck={false}
                        inputMode="numeric"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
            {features.map((def) => (
              <tr key={def.id} className="apr-feature-row">
                <th scope="row">{humanize(def.id)}<span className="adm-sub">{def.description}</span></th>
                {edit.plans.map((plan) => {
                  const on = plan.features[def.id] === true;
                  return (
                    <td key={plan.id}>
                      <button
                        type="button"
                        className={`apr-toggle${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        aria-label={`${humanize(def.id)} on ${plan.id}`}
                        disabled={disabled}
                        onClick={() => toggleFeature(plan.id, def.id)}
                      >
                        {on ? 'Included' : 'Not included'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="adm-buttons">
        <Action size="sm" variant="link" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
          {showAll ? 'Show the main limits only' : `Show all ${limits.length} limits`}
        </Action>
        <span className="adm-muted">Type “unlimited” where a plan has no ceiling. Prices and everything else in the document are carried over unchanged.</span>
      </div>

      <div className="apr-addons-head">
        <h3>Add-ons</h3>
        <Action size="sm" variant="secondary" disabled={disabled} onClick={() => onChange({ ...edit, addOns: [...edit.addOns, blankAddOn(doc)] })}><Plus aria-hidden="true" />New add-on</Action>
      </div>
      {edit.addOns.length === 0 && <p className="adm-muted">This version has no add-ons.</p>}
      <div className="apr-addons">
        {edit.addOns.map((addOn, index) => (
          <AddOnCard key={`${addOn.from ?? 'new'}-${index}`} doc={doc} addOn={addOn} disabled={disabled} onChange={(next) => setAddOn(index, next)} />
        ))}
      </div>
    </div>
  );
}

function AddOnCard({ doc, addOn, disabled, onChange }: { doc: PricingDoc; addOn: AddOnEdit; disabled: boolean; onChange: (next: AddOnEdit | null) => void }) {
  const id = useId();
  const set = (field: 'id' | 'description' | 'price' | 'unit' | 'min' | 'max' | 'step') => (event: { target: { value: string } }) => onChange({ ...addOn, [field]: event.target.value });
  const free = doc.limits.filter((def) => !(def.id in addOn.extensions));
  const name = addOn.id || 'New add-on';
  return (
    <fieldset className="apr-addon" disabled={disabled}>
      <legend>{name}</legend>
      <div className="adm-form-grid">
        <label className="adm-field">
          <span className="adm-label">Id</span>
          <input value={addOn.id} onChange={set('id')} spellCheck={false} autoComplete="off" placeholder="COMPUTE_PACK" />
        </label>
        <label className="adm-field">
          <span className="adm-label">Price</span>
          <input value={addOn.price} onChange={set('price')} spellCheck={false} autoComplete="off" />
        </label>
        <label className="adm-field">
          <span className="adm-label">Unit</span>
          <input value={addOn.unit} onChange={set('unit')} spellCheck={false} autoComplete="off" />
        </label>
        <label className="adm-field apr-wide">
          <span className="adm-label">Description</span>
          <input value={addOn.description} onChange={set('description')} autoComplete="off" />
        </label>
      </div>

      <div className="apr-addon-row">
        <span className="adm-label" id={`${id}-plans`}>Available for</span>
        <span className="apr-checks" role="group" aria-labelledby={`${id}-plans`}>
          {doc.plans.map((plan) => (
            <label key={plan.id} className="adm-check">
              <input
                type="checkbox"
                checked={addOn.availableFor.includes(plan.id)}
                onChange={(event) => onChange({ ...addOn, availableFor: event.target.checked ? [...addOn.availableFor, plan.id] : addOn.availableFor.filter((item) => item !== plan.id) })}
              />
              {plan.id}
            </label>
          ))}
        </span>
      </div>

      <div className="adm-form-grid apr-quantities">
        <label className="adm-field"><span className="adm-label">Minimum quantity</span><input value={addOn.min} onChange={set('min')} inputMode="numeric" /></label>
        <label className="adm-field"><span className="adm-label">Maximum quantity</span><input value={addOn.max} onChange={set('max')} inputMode="numeric" /></label>
        <label className="adm-field"><span className="adm-label">Step</span><input value={addOn.step} onChange={set('step')} inputMode="numeric" /></label>
      </div>

      <div className="apr-addon-row">
        <span className="adm-label">One unit adds</span>
        <ul className="apr-extensions">
          {Object.entries(addOn.extensions).map(([limitId, text]) => (
            <li key={limitId}>
              <label className="adm-field">
                <span className="adm-label">{limitLabel(doc, limitId)}</span>
                <input
                  value={text}
                  onChange={(event) => onChange({ ...addOn, extensions: { ...addOn.extensions, [limitId]: event.target.value } })}
                  aria-label={`${name} adds ${limitLabel(doc, limitId).toLowerCase()}`}
                  aria-invalid={text.trim() !== '' && typeof parseLimitInput(text) !== 'number' ? true : undefined}
                  inputMode="numeric"
                  spellCheck={false}
                />
              </label>
              <Action
                size="sm"
                variant="ghost"
                aria-label={`Remove ${limitLabel(doc, limitId).toLowerCase()} from ${name}`}
                onClick={() => onChange({ ...addOn, extensions: Object.fromEntries(Object.entries(addOn.extensions).filter(([key]) => key !== limitId)) })}
              ><Trash2 aria-hidden="true" /></Action>
            </li>
          ))}
        </ul>
        {free.length > 0 && (
          <label className="adm-field apr-add-limit">
            <span className="adm-label">Add a limit</span>
            <select value="" onChange={(event) => event.target.value && onChange({ ...addOn, extensions: { ...addOn.extensions, [event.target.value]: '' } })}>
              <option value="">Choose a limit…</option>
              {free.map((def) => <option key={def.id} value={def.id}>{limitLabel(doc, def.id)}</option>)}
            </select>
          </label>
        )}
      </div>

      <div className="adm-buttons">
        <Action size="sm" variant="danger-outline" onClick={() => onChange(null)}><Trash2 aria-hidden="true" />Remove add-on</Action>
      </div>
    </fieldset>
  );
}
