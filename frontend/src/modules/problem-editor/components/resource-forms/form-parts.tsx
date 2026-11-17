import { useId, useState, type ReactNode } from 'react';
import { Action } from '../../../core/components/action-button';
import {
  DEFAULT_AST_ASSERTION,
  DEFAULT_CEL_ASSERTION,
  IDENTIFIER_PATTERN,
  isRecord,
  isSourceExpression,
  nextIdentifier,
  optionalNumber,
  type InternalReference,
  type NumberMap,
} from '../../utils/documents';
import * as fx from '../../utils/styles';

/** The pieces the resource forms are made of: sections, cards, renaming fields and the small editors for maps, references and expressions. */

export function RenameField({
  label,
  ariaLabel,
  value,
  validate,
  onCommit,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  validate?: (nextValue: string) => string | undefined;
  onCommit: (nextValue: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const errorId = useId();

  const commit = (nextValue = draft) => {
    if (nextValue === value) {
      setError('');
      return;
    }
    const issue = !IDENTIFIER_PATTERN.test(nextValue)
      ? 'Start with a letter and use only letters, numbers, dots, underscores, or hyphens.'
      : validate?.(nextValue);
    if (issue) {
      setDraft(value);
      setError(issue);
      return;
    }
    setError('');
    onCommit(nextValue);
  };

  return (
    <label className={fx.LABEL}>
      {label}
      <input
        aria-label={ariaLabel}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        value={draft}
        pattern="[A-Za-z][A-Za-z0-9_.-]*"
        onChange={event => {
          setDraft(event.target.value);
          setError('');
        }}
        onBlur={event => commit(event.currentTarget.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(value);
            setError('');
          }
        }}
      />
      {error && (
        <small id={errorId} role="alert" className={fx.ALERT}>
          {error}
        </small>
      )}
    </label>
  );
}

export function FormSection({
  eyebrow,
  title,
  description,
  count,
  children,
  className = '',
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  count?: number | string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${fx.SECTION} ${className}`.trim()}>
      <header className={fx.SECTION_HEADING}>
        <div>
          {eyebrow && <span className={fx.MICRO_LABEL}>{eyebrow}</span>}
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        {count !== undefined && (
          <span className={fx.COUNT} aria-label={`${count} items`}>
            {count}
          </span>
        )}
      </header>
      <div className={fx.SECTION_BODY}>{children}</div>
    </section>
  );
}

export function FormCard({
  title,
  eyebrow,
  summary,
  children,
  actions,
  className = '',
}: {
  title: ReactNode;
  eyebrow?: string;
  summary?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <article className={`${fx.CARD} ${className}`.trim()}>
      <header className={fx.CARD_HEADING}>
        <div>
          {eyebrow && <span className={fx.MICRO_LABEL}>{eyebrow}</span>}
          <h4>{title}</h4>
          {summary && <p>{summary}</p>}
        </div>
        {actions && <div className={fx.CARD_ACTIONS}>{actions}</div>}
      </header>
      <div className={fx.CARD_BODY}>{children}</div>
    </article>
  );
}

export function EmptyFormState({ children }: { children: ReactNode }) {
  return <p className={fx.EMPTY}>{children}</p>;
}

export function ReferenceEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: InternalReference | undefined;
  onChange: (next: InternalReference) => void;
}) {
  return (
    <fieldset className={fx.REFERENCE}>
      <legend className={fx.LEGEND}>{label}</legend>
      <div className={fx.GRID_COMPACT}>
        <label>
          Resource
          <input
            aria-label={`${id} ${label} resource`}
            value={value?.resource || ''}
            onChange={event => onChange({ ...value, resource: event.target.value })}
            placeholder="resource id"
          />
        </label>
        <label>
          Element
          <input
            aria-label={`${id} ${label} id`}
            value={value?.id || ''}
            onChange={event => onChange({ ...value, id: event.target.value })}
            placeholder="element id"
          />
        </label>
      </div>
    </fieldset>
  );
}

export function ConstraintExpressionEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const language = typeof value === 'string' ? 'cel' : 'ast';
  // What was typed but is not a valid expression yet is kept here, together with the value it was typed against; the moment the
  // document holds another value the text is read from the document again.
  const [unfinished, setUnfinished] = useState<{ basis: unknown; source: string } | null>(null);
  const pending = unfinished && unfinished.basis === value ? unfinished : null;
  const draft = pending
    ? pending.source
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);
  const error = pending
    ? 'Enter a BIM expression AST using literal, path, op/left/right, op/value, or op/args.'
    : '';

  const changeLanguage = (nextLanguage: string) => {
    if (nextLanguage === 'cel') onChange(DEFAULT_CEL_ASSERTION);
    else onChange(DEFAULT_AST_ASSERTION);
  };

  const updateDraft = (source: string) => {
    if (language === 'cel') {
      setUnfinished(null);
      onChange(source);
      return;
    }
    try {
      const parsed = JSON.parse(source);
      if (!isSourceExpression(parsed) || typeof parsed === 'string') throw new Error('invalid AST');
      setUnfinished(null);
      onChange(parsed);
    } catch {
      setUnfinished({ basis: value, source });
    }
  };

  return (
    <div className={fx.EXPRESSION}>
      <div className={fx.GRID}>
        <label>
          {label} language
          <select
            aria-label={`${id} ${label} language`}
            value={language}
            onChange={event => changeLanguage(event.target.value)}
          >
            <option value="cel">CEL</option>
            <option value="ast">JSON AST</option>
          </select>
        </label>
      </div>
      <label>
        <span>{label}</span>
        <textarea
          aria-label={`${id} ${label}`}
          aria-invalid={Boolean(error)}
          value={draft}
          onChange={event => updateDraft(event.target.value)}
        />
      </label>
      {error && (
        <small role="alert" className={fx.ALERT}>
          {error}
        </small>
      )}
    </div>
  );
}

export function JsonObjectEditor({
  id,
  label,
  value,
  onChange,
  scalarOnly = true,
}: {
  id: string;
  label: string;
  value: Record<string, unknown> | undefined;
  onChange: (next: Record<string, unknown>) => void;
  scalarOnly?: boolean;
}) {
  const serialized = JSON.stringify(value || {}, null, 2);
  // Text that is not a valid object yet stays here, with the document text it was typed against.
  const [unfinished, setUnfinished] = useState<{ basis: string; source: string } | null>(null);
  const pending = unfinished && unfinished.basis === serialized ? unfinished : null;
  const draft = pending ? pending.source : serialized;
  const error = pending
    ? scalarOnly
      ? 'Enter a JSON object whose values are strings, finite numbers, booleans, or null.'
      : 'Enter a valid JSON object.'
    : '';

  const update = (source: string) => {
    try {
      const parsed: unknown = JSON.parse(source);
      if (
        !isRecord(parsed) ||
        (scalarOnly &&
          Object.values(parsed).some(
            item =>
              item !== null &&
              (!['string', 'number', 'boolean'].includes(typeof item) ||
                (typeof item === 'number' && !Number.isFinite(item)))
          ))
      ) {
        throw new Error('not a scalar map');
      }
      setUnfinished(null);
      onChange(parsed);
    } catch {
      setUnfinished({ basis: serialized, source });
    }
  };

  return (
    <details className={fx.ADVANCED}>
      <summary>{label}</summary>
      <label>
        <span className="sr-only">{label}</span>
        <textarea
          aria-label={`${id} ${label}`}
          aria-invalid={Boolean(error)}
          value={draft}
          onChange={event => update(event.target.value)}
        />
        {error && (
          <small role="alert" className={fx.ALERT}>
            {error}
          </small>
        )}
      </label>
    </details>
  );
}

export function NumberMapEditor({
  id,
  label,
  value,
  onChange,
  emptyLabel = 'No resource dimensions configured.',
}: {
  id: string;
  label: string;
  value: NumberMap | undefined;
  onChange: (next: NumberMap) => void;
  emptyLabel?: string;
}) {
  const entries = Object.entries(value || {});
  const rename = (key: string, nextKey: string) => {
    if (nextKey === key || !IDENTIFIER_PATTERN.test(nextKey) || value?.[nextKey] !== undefined)
      return;
    onChange(
      Object.fromEntries(
        entries.map(([entryKey, amount]) => [entryKey === key ? nextKey : entryKey, amount])
      )
    );
  };
  const remove = (key: string) =>
    onChange(Object.fromEntries(entries.filter(([entryKey]) => entryKey !== key)));
  const add = () => {
    const key = nextIdentifier(value || {}, 'resource');
    onChange({ ...value, [key]: 0 });
  };

  return (
    <fieldset className={fx.FIELDSET}>
      <legend className={fx.LEGEND}>{label}</legend>
      {entries.length === 0 && <EmptyFormState>{emptyLabel}</EmptyFormState>}
      <div className={fx.STACK}>
        {entries.map(([key, amount]) => (
          <div className={fx.NUMBER_MAP_ROW} key={key}>
            <RenameField
              label="Dimension"
              ariaLabel={`${id} ${label} ${key} dimension`}
              value={key}
              validate={nextKey =>
                nextKey !== key && value?.[nextKey] !== undefined
                  ? `The ${nextKey} dimension already exists.`
                  : undefined
              }
              onCommit={nextKey => rename(key, nextKey)}
            />
            <label>
              Amount
              <input
                aria-label={`${id} ${label} ${key} amount`}
                type="number"
                min="0"
                step="any"
                value={amount}
                onChange={event => {
                  const nextAmount = optionalNumber(event.target.value);
                  if (nextAmount !== undefined && nextAmount >= 0)
                    onChange({ ...value, [key]: nextAmount });
                }}
              />
            </label>
            <Action variant="ghost" size="sm" onClick={() => remove(key)}>
              Remove
            </Action>
          </div>
        ))}
      </div>
      <Action variant="secondary" size="sm" onClick={add}>
        Add dimension
      </Action>
    </fieldset>
  );
}

export function ReferenceListEditor({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: InternalReference[] | undefined;
  onChange: (next: InternalReference[]) => void;
}) {
  const references = value || [];
  return (
    <fieldset className={fx.FIELDSET}>
      <legend className={fx.LEGEND}>{label}</legend>
      {references.length === 0 && <EmptyFormState>No references yet.</EmptyFormState>}
      <div className={fx.STACK}>
        {references.map((reference, index) => (
          <div className={fx.REFERENCE_ROW} key={index}>
            <ReferenceEditor
              id={`${id} reference ${index + 1}`}
              label={`Reference ${index + 1}`}
              value={reference}
              onChange={next =>
                onChange(references.map((item, itemIndex) => (itemIndex === index ? next : item)))
              }
            />
            <Action
              variant="ghost"
              size="sm"
              disabled={references.length <= 1}
              onClick={() => onChange(references.filter((_, itemIndex) => itemIndex !== index))}
            >
              Remove
            </Action>
          </div>
        ))}
      </div>
      <Action
        variant="secondary"
        size="sm"
        onClick={() => onChange([...references, { resource: 'catalog', id: 'candidate' }])}
      >
        Add reference
      </Action>
    </fieldset>
  );
}
