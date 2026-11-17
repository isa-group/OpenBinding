import { useId, useState, type FormEvent } from 'react';
import { MdAdd, MdWarningAmber } from 'react-icons/md';
import { type EngineCatalogEntry } from '../../../../engine/api/engineClient';
import type { Organization } from '../../../api/organizationClient';
import { Action } from '../../../../core/components/action-button';
import { FormField } from '../../../../core/components/form-field';
import { Modal } from '../../../../core/components/modal';
import { Notice } from '../../../../core/components/notice';
import { Skeleton } from '../../../../core/components/skeleton';
import { PRESET_PAGE, presetsApi } from '../../../../run/api/presetsApi';
import {
  presetEngineText,
  presetOptimizationText,
  presetOptionsText,
  presetRegistrationText,
  studyPresetRefusal,
} from '../../../../run/api/presetText';
import { generalFailure } from '../../../../core/utils/general-failure';
import { launchPath } from '../../../../../routes/paths/runs';
import { classifyAuthError, marker } from '../../../../core/api/errors';
import type { RunPresetList, RunPresetView } from '../../../../core/api/types';
import { formatDate } from '../../../../core/utils/format';
import { useResource } from '../../../../core/hooks/useResource';
import { atLeast } from '../../../utils/org-tree';
import { SelectField, TextAreaField } from '../../../../core/components/select-field';
import {
  OPTIMIZATION_TYPES,
  draftOf,
  draftSlug,
  engineOptions,
  readDraft,
  type EngineOption,
  type PresetDraft,
} from '../presetForm';
import TabCard from './TabCard';
import { engineClient } from '../../../../engine/api/engineClient';

/** The words for a refused save or delete of a preset. */
function presetRefusal(caught: unknown, nothing: string): string {
  const failure = classifyAuthError(caught);
  const at = marker(failure);
  if (failure.code === 'slug_conflict')
    return `Another preset of this organization has that address${at}. Change it. ${nothing}`;
  if (failure.status === 403) return `Run presets are changed by MEMBER and above${at}. ${nothing}`;
  if (failure.status === 404)
    return `The preset no longer exists${at}; someone may have deleted it. ${nothing}`;
  if (failure.status === 412)
    return `Someone changed the preset since you opened it${at}. Close this and open it again. ${nothing}`;
  if (failure.status === 422)
    return `The gateway refused a setting${at}.${failure.message ? ` ${failure.message}` : ''} ${nothing}`;
  return generalFailure(failure, nothing.replace(/\.$/, '').toLowerCase());
}

interface PresetDialogProps {
  org: string;
  /** The preset to change, or `null` for a new one. */
  preset: RunPresetView | null;
  engines: readonly EngineCatalogEntry[];
  onClose: () => void;
  onSaved: (preset: RunPresetView, created: boolean) => void;
}

/** Create or change a run preset: its name, the engine and mode, the options and the optimization. */
function PresetDialog({ org, preset, engines, onClose, onSaved }: PresetDialogProps) {
  const [draft, setDraft] = useState<PresetDraft>(() => draftOf(preset));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const choices: EngineOption[] = engineOptions(engines, preset?.engine);
  const engine = choices.find(option => option.key === draft.engineKey);
  const mode = engine?.modes.find(item => item.id === draft.mode);
  const reading = readDraft(draft, choices, preset);
  const shown = tried ? reading.errors : {};
  const registration = preset ? presetRegistrationText(preset.registration) : null;
  const edit = (patch: Partial<PresetDraft>) => {
    setDraft(current => ({ ...current, ...patch }));
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!reading.settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      const head = { name: draft.name.trim(), description: draft.description.trim() };
      const answer = preset
        ? await presetsApi.update(org, preset.slug, { ...head, ...reading.settings })
        : await presetsApi.create(org, { ...head, slug: draftSlug(draft), ...reading.settings });
      onSaved(answer.value, preset === null);
    } catch (caught) {
      setError(presetRefusal(caught, 'Nothing was saved.'));
      setBusy(false);
    }
  };

  return (
    <Modal title={preset ? `Edit ${preset.name}` : 'New run preset'} onClose={onClose} size="lg">
      <form className="flex flex-col gap-4" onSubmit={event => void save(event)} noValidate>
        <FormField
          label="Name"
          value={draft.name}
          maxLength={160}
          error={shown.name}
          onChange={event => edit({ name: event.target.value })}
        />
        <FormField
          label="Address"
          value={draftSlug(draft)}
          mono
          spellCheck={false}
          disabled={preset !== null}
          error={shown.slug}
          hint={
            preset
              ? 'A preset keeps its address.'
              : 'Runs and studies name the preset by it; it can’t be changed later.'
          }
          onChange={event => edit({ slug: event.target.value })}
        />
        <FormField
          label="Description (optional)"
          value={draft.description}
          maxLength={2000}
          onChange={event => edit({ description: event.target.value })}
        />
        <SelectField
          label="Engine"
          value={draft.engineKey}
          onChange={value => edit({ engineKey: value, mode: '' })}
          hint={
            shown.engine ??
            (engines.length === 0 ? 'The engine catalogue couldn’t be read.' : undefined)
          }
        >
          <option value="">Choose an engine</option>
          {choices.map(option => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Mode"
          value={draft.mode}
          onChange={value => edit({ mode: value })}
          disabled={!engine}
        >
          <option value="">The engine’s default mode</option>
          {(engine?.modes ?? []).map(item => (
            <option key={item.id} value={item.id}>
              {item.id}
            </option>
          ))}
          {draft.mode && !engine?.modes.some(item => item.id === draft.mode) && (
            <option value={draft.mode}>{draft.mode}</option>
          )}
        </SelectField>
        <TextAreaField
          label="Options (JSON object, optional)"
          mono
          rows={4}
          spellCheck={false}
          value={draft.options}
          placeholder='{"time_budget_ms": 30000}'
          error={shown.options}
          hint={
            mode && mode.options.length > 0
              ? `This mode declares ${mode.options.join(', ')}. A time budget is in milliseconds.`
              : 'Empty: the engine’s own defaults.'
          }
          onChange={event => edit({ options: event.target.value })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Optimization"
            value={draft.optimizationType}
            onChange={value => edit({ optimizationType: value as PresetDraft['optimizationType'] })}
          >
            <option value="">Chosen for the problem when a run starts</option>
            {OPTIMIZATION_TYPES.map(type => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </SelectField>
          {draft.optimizationType && (
            <FormField
              label="Scalarization"
              value={draft.scalarization}
              list={listId}
              error={shown.optimization}
              onChange={event => edit({ scalarization: event.target.value })}
            />
          )}
          <datalist id={listId}>
            {(mode?.scalarizations ?? [])
              .filter(
                item => !draft.optimizationType || item.types.includes(draft.optimizationType)
              )
              .map(item => (
                <option key={item.id} value={item.id} />
              ))}
          </datalist>
        </div>
        <span className="text-xs text-tp-steel">
          A study takes a preset only when it names an optimization.
        </span>
        {registration && (
          <span className="text-xs text-tp-steel">
            Runs on the deployment {registration}, as it was saved from a run; this form keeps it.
          </span>
        )}
        <div aria-live="assertive">
          {error && (
            <div
              className="flex items-start gap-2 rounded-md border border-tp-severity-error-border bg-tp-severity-error-bg px-3 py-2 text-sm text-tp-error-text"
              role="alert"
            >
              <MdWarningAmber aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="primary" busy={busy}>
            {preset ? 'Save changes' : 'Create preset'}
          </Action>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({
  org,
  preset,
  onClose,
  onDeleted,
}: {
  org: string;
  preset: RunPresetView;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await presetsApi.remove(org, preset.slug);
      onDeleted();
    } catch (caught) {
      setError(presetRefusal(caught, 'Nothing was deleted.'));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Delete ${preset.name}?`} onClose={onClose} tone="danger" size="md">
      <div className="flex flex-col gap-4">
        <p>
          Runs started from it keep the settings they copied. A study that names it can’t run again
          until it names another engine or preset.
        </p>
        <div aria-live="assertive">
          {error && (
            <div
              className="flex items-start gap-2 rounded-md border border-tp-severity-error-border bg-tp-severity-error-bg px-3 py-2 text-sm text-tp-error-text"
              role="alert"
            >
              <MdWarningAmber aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action variant="danger" busy={busy} onClick={() => void remove()}>
            Delete preset
          </Action>
        </div>
      </div>
    </Modal>
  );
}

function PresetCard({
  preset,
  canWrite,
  org,
  onEdit,
  onDelete,
}: {
  preset: RunPresetView;
  canWrite: boolean;
  org: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const registration = presetRegistrationText(preset.registration);
  const optimization = presetOptimizationText(preset.optimization);
  const forStudies = studyPresetRefusal(preset);
  return (
    <li className="rounded-xl border border-tp-hairline bg-tp-canvas p-4" aria-label={preset.name}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-tp-ink">{preset.name}</h2>
        <code className="font-mono text-xs text-tp-steel">{preset.slug}</code>
      </div>
      {preset.description && <p className="mt-1 text-sm text-tp-slate">{preset.description}</p>}
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 [&_dd]:text-tp-ink [&_dt]:text-[11px] [&_dt]:text-tp-steel">
        <div>
          <dt>Engine</dt>
          <dd>{presetEngineText(preset)}</dd>
        </div>
        {registration && (
          <div>
            <dt>Deployment</dt>
            <dd>{registration}</dd>
          </div>
        )}
        <div>
          <dt>Options</dt>
          <dd>{presetOptionsText(preset.options)}</dd>
        </div>
        <div>
          <dt>Optimization</dt>
          <dd>{optimization ?? 'Chosen for the problem when a run starts'}</dd>
        </div>
        <div>
          <dt>In studies</dt>
          <dd>{forStudies ?? 'Can be an engine of a study'}</dd>
        </div>
        <div>
          <dt>Changed</dt>
          <dd>{formatDate(preset.updated_at) ?? '—'}</dd>
        </div>
      </dl>
      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Action to={launchPath(org, { preset: preset.slug })} variant="secondary" size="sm">
            Start a run
          </Action>
          <Action variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${preset.name}`}>
            Edit
          </Action>
          <Action variant="ghost" size="sm" onClick={onDelete} aria-label={`Delete ${preset.name}`}>
            Delete
          </Action>
        </div>
      )}
    </li>
  );
}

export default function PresetsBody({ organization }: { organization: Organization }) {
  const slug = organization.slug;
  const role = organization.effective_role;
  const canWrite = atLeast(role, 'MEMBER');
  const data = useResource<RunPresetList>(`presets:${slug}`, () =>
    presetsApi.list(slug, { limit: PRESET_PAGE })
  );
  const engines = useResource<EngineCatalogEntry[]>('preset-engines', () =>
    engineClient.getEngines().catch(() => [])
  );
  const [editing, setEditing] = useState<RunPresetView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RunPresetView | null>(null);
  const [toast, setToast] = useState('');

  const failure = data.status === 'error' ? classifyAuthError(data.error) : null;
  // While a change reloads the list, the one shown stays.
  const page = data.data ?? data.stale;
  const list = page?.presets ?? [];

  return (
    <TabCard
      id="presets"
      title="Run presets"
      lede={`Named run settings of ${organization.name}: the engine, mode, options and optimization a run or a study starts from.`}
      actions={
        canWrite ? (
          <Action
            variant="primary"
            onClick={() => {
              setEditing('new');
              setToast('');
            }}
          >
            <MdAdd aria-hidden="true" className="h-4 w-4" />
            New preset
          </Action>
        ) : undefined
      }
    >
      {!canWrite && (
        <Notice tone="info">
          You’re a <strong>{role ?? 'not a member'}</strong> here: you can read the presets, with
          only the options every member may see. Creating and changing them needs MEMBER.
        </Notice>
      )}
      {toast && <Notice tone="success">{toast}</Notice>}

      {data.status === 'loading' && !page && (
        <div aria-busy="true" role="status">
          <span className="sr-only">Loading the run presets…</span>
          <Skeleton variant="panel" />
        </div>
      )}
      {failure && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={data.reload}>
              Try again
            </Action>
          }
        >
          {failure.kind === 'not-found'
            ? `This organization no longer exists${marker(failure)}.`
            : `The run presets couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}
      {data.status === 'ready' && list.length === 0 && (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-tp-hairline px-4 py-10 text-center text-sm text-tp-steel [&_strong]:text-tp-ink">
          <strong>No run presets yet</strong>
          <span>
            {canWrite
              ? 'Create one here, or save the settings of a run as a preset when you launch it.'
              : 'A member can create one here, or save the settings of a run as a preset when launching it.'}
          </span>
        </div>
      )}
      {list.length > 0 && (
        <ul
          className="grid gap-3 lg:grid-cols-2"
          aria-label={`Run presets of ${organization.name}`}
        >
          {list.map(preset => (
            <PresetCard
              key={preset.id}
              preset={preset}
              canWrite={canWrite}
              org={slug}
              onEdit={() => {
                setEditing(preset);
                setToast('');
              }}
              onDelete={() => {
                setDeleting(preset);
                setToast('');
              }}
            />
          ))}
        </ul>
      )}
      {page && page.total > list.length && (
        <span className="text-xs text-tp-steel">
          Showing the first {list.length} of {page.total} presets, by name.
        </span>
      )}

      {editing && (
        <PresetDialog
          org={slug}
          preset={editing === 'new' ? null : editing}
          engines={engines.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            setToast(
              created
                ? `Created the run preset ${saved.name}.`
                : `Saved the changes to ${saved.name}. Runs already started keep the settings they copied.`
            );
            data.reload();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          org={slug}
          preset={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setToast(`Deleted the run preset ${deleting.name}.`);
            setDeleting(null);
            data.reload();
          }}
        />
      )}
    </TabCard>
  );
}
