import { useId, useState, type ReactNode } from 'react';
import { Action } from '../../components/ui/Action';
import {
  modeLabel, parseRangeInput, rangeInputOf, toRange, toScalar, type FeatureSlot, type RangeInput, type ScalarConversion,
} from '../../utils/featureRange';
import { NumberField } from './fields';
import './FeatureCell.css';

interface FeatureCellProps {
  /** The quality (column) and the candidate (row): they name every control of the cell. */
  feature: string;
  candidate: string;
  /** What the document holds; `undefined` when the candidate has no value for this quality yet. */
  value: FeatureSlot | undefined;
  /** `null` removes the value. A range that isn't complete yet is passed as it is (an end left out) so the document stays invalid until it is. */
  onChange: (value: FeatureSlot | null) => void;
  disabled?: boolean;
  /** A missing value is flagged. */
  required?: boolean;
  /** How the single value is typed, when a screen has its own field for it (the default is the table field of the library). */
  valueInput?: (args: { value: number | null; onChange: (value: number | null) => void; disabled?: boolean }) => ReactNode;
}

const stamp = (value: FeatureSlot | undefined) => JSON.stringify(value ?? null);
const isRangeSlot = (value: FeatureSlot | undefined): value is Exclude<FeatureSlot, number> => value !== undefined && typeof value !== 'number';

/**
 * One quality of one candidate: a single number, or a range with an optional open end (`No lower limit` / `No upper limit`, which
 * write `null` for ±∞). A switch picks the mode. Going to a range keeps the number as a point (`120` → `120–120`); coming back to a
 * single value is only silent for a point, otherwise the cell asks first (it keeps the finite min, else the finite max).
 */
export function FeatureCell({ feature, candidate, value, onChange, disabled, required, valueInput }: FeatureCellProps) {
  const id = useId();
  const name = `${feature} for ${candidate}`;
  const ranged = isRangeSlot(value);
  const [typed, setTyped] = useState<{ input: RangeInput; of: string } | null>(null);
  const [asking, setAsking] = useState<{ conversion: ScalarConversion; of: string } | null>(null);
  const input = typed && typed.of === stamp(value) ? typed.input : rangeInputOf(value);
  const parse = ranged ? parseRangeInput(input) : null;
  const confirm = asking && asking.of === stamp(value) ? asking.conversion : null;

  const edit = (patch: Partial<RangeInput>) => {
    const next = { ...input, ...patch };
    const parsed = parseRangeInput(next);
    setTyped({ input: next, of: stamp(parsed.value) });
    onChange(parsed.value);
  };

  const toValue = () => {
    if (!isRangeSlot(value)) return;
    const conversion = toScalar(value);
    if (conversion.lossy) setAsking({ conversion, of: stamp(value) });
    else onChange(conversion.value);
  };
  const toRangeMode = () => {
    setAsking(null);
    onChange(value === undefined ? {} : toRange(value));
  };

  const errors = parse?.errors ?? {};
  const message = errors.min ?? errors.max ?? errors.range;
  const messageId = `${id}-error`;
  const end = (side: 'min' | 'max') => {
    const open = side === 'min' ? input.minOpen : input.maxOpen;
    const label = side === 'min' ? 'Min' : 'Max';
    const limit = side === 'min' ? 'No lower limit' : 'No upper limit';
    const invalid = Boolean(errors[side] || errors.range);
    return (
      <div className="fc-end">
        <label className="fc-bound">
          <span>{label}</span>
          <input
            className="fc-input"
            inputMode="decimal"
            autoComplete="off"
            aria-label={`${name} ${side}`}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid && message ? messageId : undefined}
            value={open ? (side === 'min' ? '−∞' : '+∞') : input[side]}
            disabled={disabled || open}
            readOnly={open}
            onChange={(event) => edit(side === 'min' ? { min: event.target.value } : { max: event.target.value })}
          />
        </label>
        <label className="fc-open">
          <input
            type="checkbox"
            aria-label={`${name}: ${limit.toLowerCase()}`}
            checked={open}
            disabled={disabled}
            onChange={(event) => edit(side === 'min' ? { minOpen: event.target.checked } : { maxOpen: event.target.checked })}
          />
          <span>{limit}</span>
        </label>
      </div>
    );
  };

  return (
    <div className={`fc${ranged ? ' is-range' : ''}`}>
      <div className="fc-modes" role="group" aria-label={modeLabel(feature, candidate)}>
        <button type="button" className="fc-mode" aria-pressed={!ranged} disabled={disabled} onClick={toValue}>Value</button>
        <button type="button" className="fc-mode" aria-pressed={ranged} disabled={disabled} onClick={toRangeMode}>Range</button>
      </div>
      {!ranged && (valueInput
        ? valueInput({ value: typeof value === 'number' ? value : null, onChange, disabled })
        : <NumberField label={name} value={typeof value === 'number' ? value : null} required={required} disabled={disabled} onChange={onChange} />)}
      {ranged && <div className="fc-range">{end('min')}{end('max')}</div>}
      {ranged && message && <span id={messageId} className="lib-cell-error fc-error" role="alert">{message}</span>}
      {confirm && (
        <div className="fc-confirm" role="alertdialog" aria-label={`Convert ${name} to a single value`} onKeyDown={(event) => { if (event.key === 'Escape') setAsking(null); }}>
          <span>
            {confirm.value === null
              ? 'A single value can’t hold a range with no limits. Convert and leave it empty?'
              : `Convert to ${confirm.value.toLocaleString('en-US', { maximumFractionDigits: 6 })}? This drops ${confirm.dropped}.`}
          </span>
          <span className="fc-confirm-actions">
            <Action variant="secondary" size="sm" onClick={() => { setAsking(null); onChange(confirm.value); }}>Convert</Action>
            <Action variant="ghost" size="sm" onClick={() => setAsking(null)}>Keep range</Action>
          </span>
        </div>
      )}
    </div>
  );
}
