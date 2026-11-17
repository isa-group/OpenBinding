import { useId, useState, type ReactNode } from 'react';
import { Action } from '../../../core/components/action-button';
import {
  modeLabel,
  parseRangeInput,
  rangeInputOf,
  toRange,
  toScalar,
  type FeatureSlot,
  type RangeInput,
  type ScalarConversion,
} from '../../../../utils/featureRange';
import { NumberField } from './number-field';

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
  valueInput?: (args: {
    value: number | null;
    onChange: (value: number | null) => void;
    disabled?: boolean;
  }) => ReactNode;
}

/** The small fields of a cell; `!` keeps them small inside the editor's field styles. */
const CELL_INPUT =
  'h-[30px]! w-[84px]! min-w-0 rounded-md border border-tp-input-border bg-tp-input-bg px-2! text-[13px]! text-tp-ink disabled:cursor-not-allowed disabled:bg-tp-surface disabled:text-tp-steel aria-invalid:border-tp-severity-error';
const MODE =
  'min-h-6 cursor-pointer px-2 text-[11px] font-semibold text-tp-steel disabled:cursor-not-allowed disabled:opacity-60 aria-pressed:bg-tp-ink aria-pressed:text-tp-canvas';

const stamp = (value: FeatureSlot | undefined) => JSON.stringify(value ?? null);
const isRangeSlot = (value: FeatureSlot | undefined): value is Exclude<FeatureSlot, number> =>
  value !== undefined && typeof value !== 'number';

/**
 * One quality of one candidate: a single number, or a range with an optional open end (`No lower limit` / `No upper limit`, which
 * write `null` for ±∞). A switch picks the mode. Going to a range keeps the number as a point (`120` → `120–120`); coming back to a
 * single value is only silent for a point, otherwise the cell asks first (it keeps the finite min, else the finite max).
 */
export function FeatureCell({
  feature,
  candidate,
  value,
  onChange,
  disabled,
  required,
  valueInput,
}: FeatureCellProps) {
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
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <label className="inline-flex items-center gap-1 text-[11px] font-semibold text-tp-steel">
          <span className="min-w-6">{label}</span>
          <input
            className={CELL_INPUT}
            inputMode="decimal"
            autoComplete="off"
            aria-label={`${name} ${side}`}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid && message ? messageId : undefined}
            value={open ? (side === 'min' ? '−∞' : '+∞') : input[side]}
            disabled={disabled || open}
            readOnly={open}
            onChange={event =>
              edit(side === 'min' ? { min: event.target.value } : { max: event.target.value })
            }
          />
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] whitespace-nowrap text-tp-slate">
          <input
            type="checkbox"
            aria-label={`${name}: ${limit.toLowerCase()}`}
            checked={open}
            disabled={disabled}
            onChange={event =>
              edit(
                side === 'min'
                  ? { minOpen: event.target.checked }
                  : { maxOpen: event.target.checked }
              )
            }
          />
          <span>{limit}</span>
        </label>
      </div>
    );
  };

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div
        className="inline-flex overflow-hidden rounded-md border border-tp-hairline bg-tp-surface"
        role="group"
        aria-label={modeLabel(feature, candidate)}
      >
        <button
          type="button"
          className={MODE}
          aria-pressed={!ranged}
          disabled={disabled}
          onClick={toValue}
        >
          Value
        </button>
        <button
          type="button"
          className={`${MODE} border-l border-tp-hairline`}
          aria-pressed={ranged}
          disabled={disabled}
          onClick={toRangeMode}
        >
          Range
        </button>
      </div>
      {!ranged &&
        (valueInput ? (
          valueInput({ value: typeof value === 'number' ? value : null, onChange, disabled })
        ) : (
          <NumberField
            label={name}
            value={typeof value === 'number' ? value : null}
            required={required}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      {ranged && (
        <div className="flex min-w-0 flex-col gap-1">
          {end('min')}
          {end('max')}
        </div>
      )}
      {ranged && message && (
        <span
          id={messageId}
          className="mt-0.5 block max-w-[220px] text-[11px] whitespace-normal text-tp-error-text"
          role="alert"
        >
          {message}
        </span>
      )}
      {confirm && (
        <div
          className="flex max-w-[240px] flex-col gap-1.5 rounded-md border border-tp-severity-warning bg-tp-surface p-2 text-xs whitespace-normal"
          role="alertdialog"
          aria-label={`Convert ${name} to a single value`}
          onKeyDown={event => {
            if (event.key === 'Escape') setAsking(null);
          }}
        >
          <span>
            {confirm.value === null
              ? 'A single value can’t hold a range with no limits. Convert and leave it empty?'
              : `Convert to ${confirm.value.toLocaleString('en-US', { maximumFractionDigits: 6 })}? This drops ${confirm.dropped}.`}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <Action
              variant="secondary"
              size="sm"
              onClick={() => {
                setAsking(null);
                onChange(confirm.value);
              }}
            >
              Convert
            </Action>
            <Action variant="ghost" size="sm" onClick={() => setAsking(null)}>
              Keep range
            </Action>
          </span>
        </div>
      )}
    </div>
  );
}
