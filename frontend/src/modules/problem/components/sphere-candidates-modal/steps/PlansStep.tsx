import { useId } from 'react';
import PlanPicker from '../plan-picker';
import { serviceOf, slugOf, type SourceForm, type WizardForm } from '../recipe';
import type { Base, LoadedVersion } from '../model';
import { HINT, HEADING, INPUT, LABEL, SECTION } from './styles';

interface Props {
  form: WizardForm;
  onForm: (form: WizardForm) => void;
  /** The pricing being added, as the recipe will name it. */
  source: SourceForm;
  onSource: (source: SourceForm) => void;
  loaded: LoadedVersion;
  /** The problem the import adds to; null for a new one. */
  base: Base | null;
}

/**
 * Step 3: the task the candidates serve (an existing service task of the problem, or a new problem's name, task and capability),
 * the provider key, the plans and add-on variants to import (SPHERE's catalog picker over the version's snapshot), the billing
 * period among those the pricing declares and, for per-seat plans, the seats.
 */
export default function PlansStep({ form, onForm, source, onSource, loaded, base }: Props) {
  const id = useId();
  const { summary } = loaded;
  const tasks = base?.facts?.tasks.filter(task => task.kind === 'service') ?? [];
  const billings = summary.billing.map(entry => entry.id);
  const ownBilling = !billings.includes(form.billing);
  const perSeat = summary.plans.some(plan => plan.perSeat);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={SECTION} aria-labelledby={`${id}-task`}>
        <h3 id={`${id}-task`} className={HEADING}>
          {form.problem ? 'The new problem' : 'The task'}
        </h3>
        {form.problem && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="min-w-0">
              <span className={LABEL}>Name</span>
              <input
                className={INPUT}
                value={form.problem.name}
                onChange={event =>
                  onForm({
                    ...form,
                    problem: { name: event.target.value, slug: slugOf(event.target.value) },
                  })
                }
                placeholder="e.g. Storage"
              />
              {form.problem.slug && <span className={HINT}>Its address: {form.problem.slug}</span>}
            </label>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tasks.length > 0 ? (
            <label className="min-w-0">
              <span className={LABEL}>Task</span>
              <select
                className={INPUT}
                value={form.task}
                onChange={event => onForm({ ...form, task: event.target.value })}
              >
                <option value="">Choose a task</option>
                {tasks.map(task => (
                  <option key={task.id} value={task.id}>
                    {task.id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="min-w-0">
              <span className={LABEL}>Task</span>
              <input
                className={INPUT}
                value={form.task}
                onChange={event => onForm({ ...form, task: event.target.value })}
                placeholder="e.g. export"
              />
            </label>
          )}
          <label className="min-w-0">
            <span className={LABEL}>Capability</span>
            <input
              className={INPUT}
              value={form.capability}
              onChange={event =>
                onForm({
                  ...form,
                  capability: event.target.value,
                  service: serviceOf(event.target.value),
                })
              }
              placeholder="e.g. service/storage"
            />
            <span className={HINT}>
              What the candidates provide; their ids start with {form.service || 'the service'}.
            </span>
          </label>
        </div>
      </section>

      <section className={SECTION} aria-labelledby={`${id}-source`}>
        <h3 id={`${id}-source`} className={HEADING}>
          {source.title}, version {source.versionLabel}
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="min-w-0">
            <span className={LABEL}>Provider key</span>
            <input
              className={INPUT}
              value={source.provider}
              onChange={event =>
                onSource({
                  ...source,
                  provider: event.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''),
                })
              }
            />
            <span className={HINT}>The middle of each candidate’s id.</span>
          </label>
          <label className="min-w-0">
            <span className={LABEL}>Billing period</span>
            <select
              className={INPUT}
              value={source.billing ?? (ownBilling ? '' : form.billing)}
              onChange={event =>
                onSource({
                  ...source,
                  billing: event.target.value === form.billing ? null : event.target.value || null,
                })
              }
            >
              {ownBilling && <option value="">Choose one this pricing declares</option>}
              {billings.map(billing => (
                <option key={billing} value={billing}>
                  {billing}
                </option>
              ))}
            </select>
            {ownBilling && (
              <span className={HINT}>
                This pricing does not declare {form.billing}; choose one of its own.
              </span>
            )}
          </label>
          {perSeat && (
            <label className="min-w-0">
              <span className={LABEL}>Seats</span>
              <input
                className={INPUT}
                type="number"
                min={1}
                value={source.seats ?? ''}
                onChange={event =>
                  onSource({
                    ...source,
                    seats: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
              <span className={HINT}>Per-seat prices are multiplied by them.</span>
            </label>
          )}
        </div>
        <PlanPicker
          yaml={loaded.yaml}
          summary={summary}
          value={{ plans: source.plans, addons: source.addons }}
          onChange={choice => onSource({ ...source, ...choice })}
        />
      </section>
    </div>
  );
}
