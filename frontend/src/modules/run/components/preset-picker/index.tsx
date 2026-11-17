// Pattern only, after SPHERE frontend/src/modules/pricing/components/create-pricing-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's run presets in the select and field recipe of SPHERE's create form: "Start from a preset", the
// attached preset read-only with Edit, and "Save as preset" in SPHERE's modal.

import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MdWarningAmber } from 'react-icons/md';
import { Action } from '../../../core/components/action-button';
import { Chip } from '../../../core/components/chip';
import { FormField } from '../../../core/components/form-field';
import { Modal } from '../../../core/components/modal';
import { presetsApi, type PresetSettings } from '../../api/presetsApi';
import {
  presetEngineText,
  presetOptimizationText,
  presetOptionsText,
  presetRegistrationText,
} from '../../api/presetText';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { SLUG_PATTERN, slugFromName } from '../../../core/utils/slug';
import type { RunPresetView } from '../../../core/api/types';
import type { ModeChoice } from '../../utils/launchModel';

interface PresetPickerProps {
  /** The organization's presets; `null` when they could not be read. */
  presets: readonly RunPresetView[] | null;
  /** The slug of the attached preset, or `null` for settings chosen here. */
  value: string | null;
  onChange: (slug: string | null) => void;
  /** Where the organization's presets are managed (the settings section). */
  manageHref: string;
}

/** "Start from a preset": a select of the organization's run presets. Picking one fills the engine, mode, options and optimization. */
export function PresetPicker({ presets, value, onChange, manageHref }: PresetPickerProps) {
  const id = useId();
  const list = presets ?? [];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-tp-slate">
        Start from a preset
      </label>
      <select
        id={id}
        className="h-10 w-full cursor-pointer rounded-md border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink outline-none focus:border-tp-primary disabled:cursor-not-allowed disabled:opacity-60"
        value={value ?? ''}
        disabled={list.length === 0}
        onChange={event => onChange(event.target.value || null)}
        aria-describedby={`${id}-note`}
      >
        <option value="">No preset: choose the settings here</option>
        {list.map(preset => (
          <option key={preset.id} value={preset.slug}>
            {preset.name} · {presetEngineText(preset)}
          </option>
        ))}
      </select>
      <span id={`${id}-note`} className="text-xs text-tp-steel">
        {presets === null
          ? 'The organization’s run presets couldn’t be loaded; choose the settings here.'
          : list.length === 0
            ? 'This organization has no run preset yet.'
            : 'A preset fills the engine, mode, options and optimization. The run copies them and records the preset.'}{' '}
        <Link to={manageHref} className="cursor-pointer font-medium text-tp-accent hover:underline">
          Manage run presets
        </Link>
      </span>
    </div>
  );
}

interface AttachedPresetProps {
  preset: RunPresetView;
  /** The offered engine mode the preset names, when the gateway listed it for this problem version. */
  mode: ModeChoice | null;
  /** Detach the preset: its settings move into the form, to be changed there. */
  onDetach: () => void;
}

/** What an attached preset runs with, read-only, and the way to change it ("Edit" detaches it). */
export function AttachedPreset({ preset, mode, onDetach }: AttachedPresetProps) {
  const registration = presetRegistrationText(preset.registration);
  const optimization = presetOptimizationText(preset.optimization);
  return (
    <section
      aria-label={`Run preset ${preset.name}`}
      className="flex flex-col gap-3 rounded-lg border border-tp-primary/30 bg-tp-primary/5 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-tp-ink">From the preset {preset.name}</h3>
        {mode?.compat === 'yes' && <Chip tone="success">Can run this</Chip>}
        {mode?.compat === 'no' && <Chip tone="warning">Can’t run this</Chip>}
        {(!mode || mode.compat === 'unknown') && <Chip>Checked when you send</Chip>}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink [&_dt]:text-tp-steel">
        <dt>Engine</dt>
        <dd>{presetEngineText(preset)}</dd>
        {registration && (
          <>
            <dt>Deployment</dt>
            <dd>{registration}</dd>
          </>
        )}
        <dt>Options</dt>
        <dd>{presetOptionsText(preset.options)}</dd>
        <dt>Optimization</dt>
        <dd>{optimization ?? 'Chosen for the problem when the run starts'}</dd>
      </dl>
      {mode?.compat === 'no' && mode.reason && (
        <p className="text-xs text-tp-error-text">{mode.reason}</p>
      )}
      <span className="text-xs text-tp-steel">
        The run copies these settings and records the preset, so changing the preset later never
        changes this run.
      </span>
      <span className="flex gap-2">
        <Action variant="secondary" size="sm" onClick={onDetach}>
          Edit
        </Action>
      </span>
    </section>
  );
}

interface SavePresetDialogProps {
  org: string;
  settings: PresetSettings;
  /** What the settings say, as the review shows them. */
  summary: string;
  onClose: () => void;
  onSaved: (preset: RunPresetView) => void;
}

/** "Save these settings as a preset" (MEMBER): a name, an address and a description for the settings chosen by hand. */
export function SavePresetDialog({
  org,
  settings,
  summary,
  onClose,
  onSaved,
}: SavePresetDialogProps) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = address ?? slugFromName(name);
  const valid = name.trim() !== '' && SLUG_PATTERN.test(slug);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await presetsApi.create(org, {
        slug,
        name: name.trim(),
        description: description.trim(),
        ...settings,
      });
      onSaved(saved.value);
    } catch (caught) {
      const failure = classifyAuthError(caught);
      setError(
        failure.code === 'slug_conflict'
          ? `Another preset of this organization has that address${marker(failure)}. Change it.`
          : failure.status === 403
            ? `Saving a preset needs MEMBER${marker(failure)}.`
            : `The preset couldn’t be saved${marker(failure)}.${failure.message ? ` ${failure.message}` : ''}`
      );
      setBusy(false);
    }
  };

  return (
    <Modal title="Save as a run preset" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={event => void save(event)}>
        <p className="text-sm text-tp-steel">
          {summary}. Runs and studies of this organization can start from it.
        </p>
        <FormField
          label="Preset name"
          value={name}
          maxLength={160}
          onChange={event => {
            setName(event.target.value);
            setError(null);
          }}
        />
        <FormField
          label="Preset address"
          value={slug}
          mono
          spellCheck={false}
          onChange={event => {
            setAddress(event.target.value);
            setError(null);
          }}
          error={
            slug && !SLUG_PATTERN.test(slug) ? 'Lowercase letters, numbers and hyphens.' : undefined
          }
          hint="It names the preset in runs and studies; it can’t be changed later."
        />
        <FormField
          label="Description (optional)"
          value={description}
          maxLength={2000}
          onChange={event => setDescription(event.target.value)}
        />
        <div aria-live="assertive">
          {error && (
            <p className="flex items-start gap-2 text-sm text-tp-error-text" role="alert">
              <MdWarningAmber aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </p>
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="primary" disabled={!valid} busy={busy}>
            Save preset
          </Action>
        </div>
      </form>
    </Modal>
  );
}
