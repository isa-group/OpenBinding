// The fields of the study form: the problem versions (as SPHERE's pricings selector, a grid of selectable cards), the
// engines and run presets, and the settings and seeds. Adapted from SPHERE
// frontend/src/modules/profile/components/pricings-selector/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE's bordered grid of selectable cards holds the organization's problem versions (newest first per problem),
// the engine modes and the run presets; the settings and seeds are OpenBinding's own fields, restyled. The selection logic
// (latest of each problem, presets a study cannot take, the plan's time ceiling) is OpenBinding's.

import { Link } from 'react-router-dom';
import { MdAdd, MdDeleteOutline } from 'react-icons/md';
import { formatDate } from '../../../../utils/format';
import { problemsPath } from '../../../../routes/paths/problems';
import type { RunPresetView } from '../../../core/api/types';
import { Chip } from '../../../core/components/chip';
import { engineLabel } from '../../../core/utils/identity';
import {
  presetEngineText,
  presetOptionsText,
  studyPresetRefusal,
} from '../../../run/api/presetText';
import {
  MAX_SETTINGS,
  describeParameters,
  latestExecutable,
  offeredRevisions,
  plural,
  readVariant,
  type CaseContent,
  type EngineChoice,
  type Variant,
} from '../../utils/studiesModel';
import { INPUT, LINK, MUTED } from '../../utils/ui';
import SelectableVersionCard from '../selectable-version-card';

const FIELDSET = 'flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-4';
const LEGEND = 'px-1 text-sm font-semibold text-tp-ink';
const GRID = 'grid grid-cols-1 gap-3 rounded-2xl border border-tp-hairline p-3 md:grid-cols-2';
const TOOL =
  'inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-tp-accent hover:bg-tp-surface disabled:cursor-default disabled:opacity-40';
const ERROR = 'text-xs text-red-700';

interface CasesFieldProps {
  cases: readonly CaseContent[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** The organization whose problems are offered. */
  org: string;
}

/** 1 · Problems: the sealed problem versions of the organization, as selectable cards. */
export function CasesField({ cases, selected, onChange, org }: CasesFieldProps) {
  const offered = offeredRevisions(cases);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]);
  return (
    <fieldset className={FIELDSET}>
      <legend className={LEGEND}>1 · Problems</legend>
      {offered.length === 0 && (
        <p className={MUTED}>
          The organization has no problem versions yet.{' '}
          <Link to={problemsPath(org)} viewTransition className={LINK}>
            Open Problems
          </Link>{' '}
          to add one.
        </p>
      )}
      {offered.length > 0 && (
        <div className={GRID} role="group" aria-label="Problem versions">
          {offered.map(({ caseName, revision }) => (
            <SelectableVersionCard
              key={revision.id}
              title={`${caseName} · version ${revision.revision}`}
              detail={`Sealed ${formatDate(revision.created_at) ?? 'on an unknown date'}`}
              selected={selected.includes(revision.id)}
              onToggle={() => toggle(revision.id)}
            />
          ))}
        </div>
      )}
      {offered.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={TOOL} onClick={() => onChange(latestExecutable(cases))}>
            Latest version of each problem
          </button>
          <button
            type="button"
            className={TOOL}
            onClick={() => onChange([])}
            disabled={selected.length === 0}
          >
            Clear
          </button>
        </div>
      )}
    </fieldset>
  );
}

interface PresetRowsProps {
  /** The organization's run presets; `null` when they could not be read. */
  presets: readonly RunPresetView[] | null;
  /** The slugs of the presets the study names. */
  selected: readonly string[];
  onChange: (slugs: string[]) => void;
  /** Where the organization's presets are managed. */
  manageHref: string;
}

/**
 * "Add from a run preset": each preset picked becomes a `{preset}` engine row that every run expands into the preset's exact engine,
 * mode, options and optimization. A preset no study can take is listed, turned off, with the reason.
 */
function PresetRows({ presets, selected, onChange, manageHref }: PresetRowsProps) {
  const toggle = (slug: string) =>
    onChange(
      selected.includes(slug) ? selected.filter(item => item !== slug) : [...selected, slug]
    );
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-tp-slate">Add from a run preset</span>
      {presets === null && (
        <p className={MUTED}>The organization’s run presets couldn’t be loaded.</p>
      )}
      {presets !== null && presets.length === 0 && (
        <p className={MUTED}>
          This organization has no run preset yet.{' '}
          <Link to={manageHref} viewTransition className={LINK}>
            Create one
          </Link>{' '}
          to reuse its settings here.
        </p>
      )}
      {presets !== null && presets.length > 0 && (
        <div className={GRID} role="group" aria-label="Run presets">
          {presets.map(preset => {
            const refusal = studyPresetRefusal(preset);
            const about = `study-preset-${preset.id}`;
            return (
              <SelectableVersionCard
                key={preset.id}
                ariaLabel={`${preset.name} · run preset`}
                describedBy={about}
                title={
                  <>
                    {preset.name}
                    <Chip>preset</Chip>
                  </>
                }
                detail={
                  <span id={about}>
                    {presetEngineText(preset)} · {presetOptionsText(preset.options)}
                    {refusal ? `. ${refusal}` : ''}
                  </span>
                }
                selected={selected.includes(preset.slug)}
                disabled={refusal !== null}
                onToggle={() => toggle(preset.slug)}
              />
            );
          })}
        </div>
      )}
      <small className={MUTED}>
        Each run copies the preset’s settings when it starts, so editing the preset changes only the
        runs after it.
      </small>
    </div>
  );
}

/** 2 · Engines: every engine revision with the modes it offers (a study pins both), and the organization's run presets. */
export function EnginesField({
  choices,
  selected,
  onChange,
  failed,
  presets,
}: {
  choices: readonly EngineChoice[];
  selected: readonly string[];
  onChange: (keys: string[]) => void;
  failed: boolean;
  presets: PresetRowsProps;
}) {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter(item => item !== key) : [...selected, key]);
  return (
    <fieldset className={FIELDSET}>
      <legend className={LEGEND}>2 · Engines</legend>
      {choices.length === 0 && (
        <p className={MUTED}>
          {failed
            ? 'The engines couldn’t be loaded right now.'
            : 'No engine is visible to this account.'}
        </p>
      )}
      {choices.length > 0 && (
        <div className={GRID} role="group" aria-label="Engine modes">
          {choices.map(choice => (
            <SelectableVersionCard
              key={choice.key}
              ariaLabel={`${choice.title} mode ${choice.mode}`}
              title={
                <>
                  {choice.title}
                  <Chip>mode {choice.mode}</Chip>
                  {choice.federated && <Chip tone="warning">federated</Chip>}
                </>
              }
              detail={`${choice.ref.namespace} · ${engineLabel({ name: choice.ref.name, version: choice.ref.version })}${
                choice.defaultSeconds !== null ? ` · default budget ${choice.defaultSeconds} s` : ''
              }`}
              selected={selected.includes(choice.key)}
              onToggle={() => toggle(choice.key)}
            />
          ))}
        </div>
      )}
      <PresetRows {...presets} />
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
export function SettingsField({
  variants,
  onChange,
  seeds,
  onSeeds,
  seedsError,
  seedCount,
  ceiling,
  duplicate,
  onAdd,
}: SettingsFieldProps) {
  const update = (id: string, patch: Partial<Variant>) =>
    onChange(variants.map(variant => (variant.id === id ? { ...variant, ...patch } : variant)));
  return (
    <fieldset className={FIELDSET}>
      <legend className={LEGEND}>3 · Settings and seeds</legend>
      <ol className="flex flex-col gap-3" aria-label="Settings">
        {variants.map((variant, position) => {
          const reading = readVariant(variant);
          const asked = Number(variant.seconds);
          const reduced =
            ceiling !== null &&
            variant.seconds.trim() !== '' &&
            Number.isFinite(asked) &&
            asked > ceiling;
          return (
            <li
              key={variant.id}
              className="flex flex-col gap-2 rounded-lg border border-tp-hairline-soft bg-tp-surface p-3"
            >
              <div className="flex items-center gap-2">
                <strong className="text-sm font-medium text-tp-ink">Setting {position + 1}</strong>
                <span className="min-w-0 flex-1 truncate text-xs text-tp-steel">
                  {reading.error ? '—' : describeParameters(reading.parameters)}
                </span>
                {variants.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove setting ${position + 1}`}
                    onClick={() => onChange(variants.filter(item => item.id !== variant.id))}
                    className="cursor-pointer rounded-md p-1 text-tp-steel hover:bg-tp-canvas hover:text-red-700"
                  >
                    <MdDeleteOutline className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
                  <span>Time budget (seconds)</span>
                  <input
                    inputMode="decimal"
                    value={variant.seconds}
                    placeholder="Engine default"
                    onChange={event => update(variant.id, { seconds: event.target.value })}
                    className={INPUT}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
                  <span>Iterations</span>
                  <input
                    inputMode="numeric"
                    value={variant.iterations}
                    placeholder="Engine default"
                    onChange={event => update(variant.id, { iterations: event.target.value })}
                    className={INPUT}
                  />
                </label>
              </div>
              <details className="text-xs text-tp-slate" open={Boolean(variant.extra)}>
                <summary className="cursor-pointer font-medium">More options</summary>
                <label className="mt-2 flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
                  <span>Other options (JSON object)</span>
                  <textarea
                    rows={3}
                    spellCheck={false}
                    value={variant.extra}
                    placeholder='{"population_size": 40}'
                    onChange={event => update(variant.id, { extra: event.target.value })}
                    className={`${INPUT} font-mono text-xs`}
                  />
                </label>
              </details>
              {reading.error && (
                <p className={ERROR} role="alert">
                  {reading.error}
                </p>
              )}
              {reduced && (
                <small className={MUTED}>
                  Your plan runs at most {ceiling} s per solve, so this setting runs at {ceiling} s;
                  the run carries that note.
                </small>
              )}
            </li>
          );
        })}
      </ol>
      {duplicate && (
        <p className={ERROR} role="alert">
          Two settings are identical, so they would repeat the same cells. Change or remove one.
        </p>
      )}
      <div>
        <button
          type="button"
          className={TOOL}
          onClick={onAdd}
          disabled={variants.length >= MAX_SETTINGS}
        >
          <MdAdd className="h-4 w-4" aria-hidden="true" />
          Add a setting
        </button>
      </div>
      <label className="flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
        <span>Seeds (comma-separated, ranges like 1-5 work)</span>
        <input
          value={seeds}
          onChange={event => onSeeds(event.target.value)}
          aria-invalid={seedsError ? true : undefined}
          aria-describedby="study-seeds-note"
          className={`${INPUT} font-mono`}
        />
        <small
          id="study-seeds-note"
          className={seedsError ? ERROR : MUTED}
          role={seedsError ? 'alert' : undefined}
        >
          {seedsError ?? `${plural(seedCount, 'seed')}. Each seed repeats every other choice once.`}
        </small>
      </label>
    </fieldset>
  );
}
