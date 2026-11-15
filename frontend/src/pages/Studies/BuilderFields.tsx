import { Plus, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CaseContent } from '../../features/workspace/model';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { problemsPath } from '../../routes/paths/problems';
import { formatDate } from '../../utils/format';
import { engineLabel } from '../../shared/lib/identity';
import {
  MAX_SETTINGS, latestExecutable, offeredRevisions, plural, readVariant,
  describeParameters, type EngineChoice, type Variant,
} from './studiesModel';

interface CasesFieldProps {
  cases: readonly CaseContent[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** The organization whose problems are offered. */
  org: string;
}

/** 1 · Cases: the executable problem revisions of the organization. */
export function CasesField({ cases, selected, onChange, org }: CasesFieldProps) {
  const offered = offeredRevisions(cases);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return (
    <fieldset className="st-fieldset">
      <legend>1 · Problems</legend>
      {offered.length === 0 && (
        <p className="st-empty-line">
          The organization has no problem versions yet. <Link to={problemsPath(org)} viewTransition>Open Problems</Link> to add one.
        </p>
      )}
      {offered.length > 0 && (
        <div className="st-options" role="group" aria-label="Problem versions">
          {offered.map(({ caseName, revision }) => (
            <label key={revision.id} className="st-option">
              <input type="checkbox" checked={selected.includes(revision.id)} onChange={() => toggle(revision.id)} />
              <span className="st-option-text">
                <span>{caseName} · version {revision.revision}</span>
                <small>{`Sealed ${formatDate(revision.created_at) ?? 'on an unknown date'}`}</small>
              </span>
            </label>
          ))}
        </div>
      )}
      {offered.length > 0 && (
        <div className="st-tools">
          <Action variant="ghost" size="sm" onClick={() => onChange(latestExecutable(cases))}>Latest version of each problem</Action>
          <Action variant="ghost" size="sm" onClick={() => onChange([])} disabled={selected.length === 0}>Clear</Action>
        </div>
      )}
    </fieldset>
  );
}

/** 2 · Engines: every engine revision with the modes it offers; a study pins both. */
export function EnginesField({ choices, selected, onChange, failed }: {
  choices: readonly EngineChoice[]; selected: readonly string[]; onChange: (keys: string[]) => void; failed: boolean;
}) {
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key]);
  return (
    <fieldset className="st-fieldset">
      <legend>2 · Engines</legend>
      {choices.length === 0 && <p className="st-empty-line">{failed ? 'The engines couldn’t be loaded right now.' : 'No engine is visible to this account.'}</p>}
      <div className="st-options" role="group" aria-label="Engine modes">
        {choices.map((choice) => (
          <label key={choice.key} className="st-option">
            <input type="checkbox" checked={selected.includes(choice.key)} onChange={() => toggle(choice.key)} />
            <span className="st-option-text">
              <span className="st-option-line">
                {choice.title}
                <Chip>mode {choice.mode}</Chip>
                {choice.federated && <Chip tone="warning">federated</Chip>}
              </span>
              <small>{choice.ref.namespace} · {engineLabel({ name: choice.ref.name, version: choice.ref.version })}{choice.defaultSeconds !== null ? ` · default budget ${choice.defaultSeconds} s` : ''}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface SettingsFieldProps {
  variants: readonly Variant[];
  onChange: (variants: Variant[]) => void;
  seeds: string;
  onSeeds: (text: string) => void;
  seedsError: string | undefined;
  seedCount: number;
  /** The most seconds the plan lets one solve use; `null` when unknown or unlimited. */
  ceiling: number | null;
  duplicate: boolean;
  onAdd: () => void;
}

/** 3 · Settings and seeds: each setting is a set of engine options (the engine's own defaults when left empty). */
export function SettingsField({ variants, onChange, seeds, onSeeds, seedsError, seedCount, ceiling, duplicate, onAdd }: SettingsFieldProps) {
  const update = (id: string, patch: Partial<Variant>) => onChange(variants.map((variant) => (variant.id === id ? { ...variant, ...patch } : variant)));
  return (
    <fieldset className="st-fieldset">
      <legend>3 · Settings and seeds</legend>
      <ol className="st-variants" aria-label="Settings">
        {variants.map((variant, position) => {
          const reading = readVariant(variant);
          const asked = Number(variant.seconds);
          const reduced = ceiling !== null && variant.seconds.trim() !== '' && Number.isFinite(asked) && asked > ceiling;
          return (
            <li key={variant.id} className="st-variant">
              <div className="st-variant-head">
                <strong>Setting {position + 1}</strong>
                <span>{reading.error ? '—' : describeParameters(reading.parameters)}</span>
                {variants.length > 1 && (
                  <button type="button" className="st-icon-button" aria-label={`Remove setting ${position + 1}`} onClick={() => onChange(variants.filter((item) => item.id !== variant.id))}>
                    <Trash2 aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="st-variant-fields">
                <label>
                  <span>Time budget (seconds)</span>
                  <input inputMode="decimal" value={variant.seconds} placeholder="Engine default" onChange={(event) => update(variant.id, { seconds: event.target.value })} />
                </label>
                <label>
                  <span>Iterations</span>
                  <input inputMode="numeric" value={variant.iterations} placeholder="Engine default" onChange={(event) => update(variant.id, { iterations: event.target.value })} />
                </label>
              </div>
              <details className="st-more" open={Boolean(variant.extra)}>
                <summary>More options</summary>
                <label>
                  <span>Other options (JSON object)</span>
                  <textarea className="proj-textarea is-mono" rows={3} spellCheck={false} value={variant.extra} placeholder='{"population_size": 40}' onChange={(event) => update(variant.id, { extra: event.target.value })} />
                </label>
              </details>
              {reading.error && <p className="st-field-error" role="alert">{reading.error}</p>}
              {reduced && <small className="org-muted">Your plan runs at most {ceiling} s per solve, so this setting runs at {ceiling} s; the run carries that note.</small>}
            </li>
          );
        })}
      </ol>
      {duplicate && <p className="st-field-error" role="alert">Two settings are identical, so they would repeat the same cells. Change or remove one.</p>}
      <div className="st-tools">
        <Action variant="ghost" size="sm" onClick={onAdd} disabled={variants.length >= MAX_SETTINGS}>
          <Plus aria-hidden="true" className="job-icon" />Add a setting
        </Action>
      </div>
      <label className="st-seeds">
        <span>Seeds (comma-separated, ranges like 1-5 work)</span>
        <input className="is-mono" value={seeds} onChange={(event) => onSeeds(event.target.value)} aria-invalid={seedsError ? true : undefined} aria-describedby="st-seeds-note" />
        <small id="st-seeds-note" className={seedsError ? 'st-field-error' : 'org-muted'} role={seedsError ? 'alert' : undefined}>
          {seedsError ?? `${plural(seedCount, 'seed')}. Each seed repeats every other choice once.`}
        </small>
      </label>
    </fieldset>
  );
}
