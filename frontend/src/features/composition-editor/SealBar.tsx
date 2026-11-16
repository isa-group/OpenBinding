import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { formatValue } from '../../entities/composition/values';
import type { CheckResult } from '../../shared/api/types';
import { ValueBadge } from '../../widgets/value-badge/ValueBadge';
import type { SealOutcome } from './useCompositionEditor';

/** What the seal's assessment says the version would hold: its values and how far they can be trusted. */
export function ValuesOnSeal({
  check,
  canonical,
  onUseCanonical,
  readOnly,
}: {
  check: CheckResult;
  canonical: boolean;
  onUseCanonical: () => void;
  readOnly: boolean;
}) {
  const id = useId();
  const values = Object.entries(check.values ?? {});
  if (!check.valid) return null;
  return (
    <section className="ce-on-seal" aria-labelledby={id}>
      <h3 id={id}>Values on seal</h3>
      <p className="cmp-muted">
        {check.values_status === 'verified' ? (
          <>
            These values will be verified: <ValueBadge status="verified" />
          </>
        ) : (
          <>
            These values will be declared: <ValueBadge status="declared" />
          </>
        )}
      </p>
      {values.length > 0 && (
        <dl className="ce-on-seal-values">
          {values.map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{formatValue(value.value, value.unit)}</dd>
            </div>
          ))}
        </dl>
      )}
      {!canonical && check.content !== null && !readOnly && (
        <Action size="sm" onClick={onUseCanonical}>
          Use the canonical form
        </Action>
      )}
    </section>
  );
}

interface SealBarProps {
  label: string;
  onLabel: (label: string) => void;
  /** MEMBER: may seal. */
  canSeal: boolean;
  errors: number;
  sealing: boolean;
  onSeal: () => void;
  /** The last seal that did not open a new version. */
  outcome: Exclude<SealOutcome, { kind: 'created' }> | null;
  /** Where a version opens, by label. */
  versionHref: (label: string) => string;
}

/** The bottom bar of the editor: the label the version is sealed under (the document's `version:`) and the seal. */
export function SealBar({
  label,
  onLabel,
  canSeal,
  errors,
  sealing,
  onSeal,
  outcome,
  versionHref,
}: SealBarProps) {
  const id = useId();
  const blocked = errors > 0;
  return (
    <div className="ce-sealbar" role="region" aria-label="Seal">
      {outcome && (
        <div className="ce-seal-outcome" aria-live="polite">
          {outcome.kind === 'exists' && (
            <Notice tone="info">
              This exact version already exists:{' '}
              <Link to={versionHref(outcome.result.version.label)}>
                {outcome.result.version.label}
              </Link>
              .
            </Notice>
          )}
          {outcome.kind === 'labelTaken' && (
            <Notice tone="error">{`${outcome.message || 'This label is taken by another version.'} Choose another label.`}</Notice>
          )}
          {outcome.kind === 'invalid' && (
            <Notice tone="error">
              The gateway refused the document. Its problems are listed with the code.
            </Notice>
          )}
          {outcome.kind === 'refused' && (
            <Notice tone="error">{`The version couldn’t be sealed${outcome.status ? ` (${outcome.status})` : ''}: ${outcome.message || 'try again in a moment.'}`}</Notice>
          )}
        </div>
      )}
      <div className="ce-sealbar-row">
        <label className="ce-label" htmlFor={id}>
          Label
          <input
            key={label}
            id={id}
            className="ce-input ce-label-input"
            defaultValue={label}
            spellCheck={false}
            disabled={!canSeal || sealing}
            onBlur={event => onLabel(event.target.value.trim())}
            onKeyDown={event => {
              if (event.key === 'Enter') onLabel((event.target as HTMLInputElement).value.trim());
            }}
          />
        </label>
        {canSeal ? (
          <>
            {blocked && (
              <span className="ce-attention" role="status">
                Needs attention
              </span>
            )}
            <Action variant="primary" busy={sealing} disabled={blocked} onClick={onSeal}>
              <Lock aria-hidden="true" />
              Seal version
            </Action>
          </>
        ) : (
          <span className="cmp-muted">Sealing versions needs MEMBER.</span>
        )}
      </div>
    </div>
  );
}
