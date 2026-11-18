import { useId, useState } from 'react';
import { MdAdd, MdDelete } from 'react-icons/md';
import {
  emptyProperty,
  demandProblems,
  type FeatureForm,
  type ManualMap,
  type PropertyForm,
  type SourceForm,
  type SpecKind,
  type WizardForm,
} from '../recipe';
import type { VersionSummary } from '../summary';
import { HEADING, HINT, INPUT, LABEL, SECTION } from './styles';

const KIND_LABEL: Record<SpecKind, string> = {
  price: 'The plan’s price per month',
  limit: 'A usage limit',
  feature: 'A feature',
  guarantee: 'A guarantee',
  constant: 'The same number for every candidate',
  manual: 'Set by hand',
};

const numberOrNull = (text: string): number | null => {
  if (text.trim() === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** The names a kind of spec may read, across the pricings of the recipe. */
function namesFor(kind: SpecKind, summaries: VersionSummary[]): string[] {
  const names = new Set<string>();
  for (const summary of summaries) {
    if (kind === 'limit') summary.usageLimits.forEach(limit => names.add(limit.name));
    if (kind === 'guarantee')
      summary.features.filter(f => f.type === 'GUARANTEE').forEach(f => names.add(f.name));
    if (kind === 'feature')
      summary.features.filter(f => f.type !== 'GUARANTEE').forEach(f => names.add(f.name));
  }
  return [...names].sort();
}

/** Whether a pricing declares a name of a kind. */
function declares(summary: VersionSummary | undefined, kind: SpecKind, name: string): boolean {
  if (!summary) return true;
  if (kind === 'limit') return summary.usageLimits.some(limit => limit.name === name);
  return summary.features.some(feature => feature.name === name);
}

interface Props {
  form: WizardForm;
  onForm: (form: WizardForm) => void;
  /** The summary of each pricing of the recipe, by version id (read in step 3). */
  summaries: Record<string, VersionSummary>;
  /** Whether the problem's features may be added and changed (a new problem). */
  editableFeatures: boolean;
}

/**
 * Step 4: how each problem feature is read from each pricing (the price, a limit, a feature, a guarantee with its table or
 * scale, one number, or values set by hand), the names a pricing gives a limit or guarantee another calls otherwise, what to
 * assume for a limit a pricing does not declare, the demand and the requirements a candidate must meet, and dominance pruning.
 */
export default function MappingStep({ form, onForm, summaries, editableFeatures }: Props) {
  const id = useId();
  const all = form.sources
    .map(source => summaries[source.versionId])
    .filter((summary): summary is VersionSummary => Boolean(summary));
  const problems = demandProblems(form);

  const setProperty = (feature: string, property: PropertyForm) =>
    onForm({ ...form, properties: { ...form.properties, [feature]: property } });
  const setSource = (index: number, source: SourceForm) =>
    onForm({ ...form, sources: form.sources.map((entry, at) => (at === index ? source : entry)) });
  const setFeature = (index: number, feature: FeatureForm) => {
    const previous = form.features[index];
    const properties = { ...form.properties };
    if (previous.id !== feature.id) {
      properties[feature.id] = properties[previous.id] ?? emptyProperty();
      delete properties[previous.id];
    }
    onForm({
      ...form,
      features: form.features.map((entry, at) => (at === index ? feature : entry)),
      properties,
    });
  };

  const limits = namesFor('limit', all);
  const booleans = [
    ...new Set(
      all.flatMap(summary =>
        summary.features.filter(f => f.valueType === 'BOOLEAN').map(f => f.name)
      )
    ),
  ].sort();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className={SECTION} aria-labelledby={`${id}-features`}>
        <h3 id={`${id}-features`} className={HEADING}>
          Problem features
        </h3>
        <p className="text-xs text-tp-steel">
          Where each value of the generated candidates comes from. A value set by hand is marked
          Manual on every screen.
        </p>
        {form.features.length === 0 && (
          <p className="text-xs text-tp-steel">The problem has no feature to fill yet.</p>
        )}
        {form.features.map((feature, index) => (
          <FeatureMapping
            key={`${index}-${feature.id}`}
            feature={feature}
            property={form.properties[feature.id] ?? emptyProperty()}
            sources={form.sources}
            summaries={summaries}
            names={namesFor((form.properties[feature.id] ?? emptyProperty()).kind, all)}
            editable={editableFeatures}
            onFeature={next => setFeature(index, next)}
            onProperty={next => setProperty(feature.id, next)}
            onSource={setSource}
            onRemove={
              editableFeatures
                ? () =>
                    onForm({
                      ...form,
                      features: form.features.filter((_, at) => at !== index),
                    })
                : undefined
            }
          />
        ))}
        {editableFeatures && (
          <AddFeature
            taken={form.features.map(feature => feature.id)}
            onAdd={feature =>
              onForm({
                ...form,
                features: [...form.features, feature],
                properties: { ...form.properties, [feature.id]: emptyProperty() },
              })
            }
          />
        )}
      </section>

      <section className={SECTION} aria-labelledby={`${id}-demand`}>
        <h3 id={`${id}-demand`} className={HEADING}>
          Demand and requirements
        </h3>
        <p className="text-xs text-tp-steel">
          A candidate whose limit is below the demand stays in the problem and is marked ineligible
          by the compiler; another demand is another version of the problem.
        </p>
        {form.demand.map((entry, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
            <label className="min-w-0">
              <span className={LABEL}>Demand</span>
              <input
                className={INPUT}
                value={entry.name}
                onChange={event =>
                  onForm({
                    ...form,
                    demand: form.demand.map((item, at) =>
                      at === index ? { ...item, name: event.target.value } : item
                    ),
                  })
                }
                placeholder="dailyEmails"
              />
            </label>
            <label className="min-w-0">
              <span className={LABEL}>Value</span>
              <input
                className={INPUT}
                type="number"
                min={0}
                value={entry.value ?? ''}
                onChange={event =>
                  onForm({
                    ...form,
                    demand: form.demand.map((item, at) =>
                      at === index ? { ...item, value: numberOrNull(event.target.value) } : item
                    ),
                  })
                }
              />
            </label>
            <label className="min-w-0">
              <span className={LABEL}>Unit</span>
              <input
                className={INPUT}
                value={entry.unit}
                onChange={event =>
                  onForm({
                    ...form,
                    demand: form.demand.map((item, at) =>
                      at === index ? { ...item, unit: event.target.value } : item
                    ),
                  })
                }
                placeholder="email/day"
              />
            </label>
            <button
              type="button"
              className="mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-tp-steel hover:bg-tp-surface"
              aria-label={`Remove the demand ${entry.name || index + 1}`}
              onClick={() =>
                onForm({ ...form, demand: form.demand.filter((_, at) => at !== index) })
              }
            >
              <MdDelete aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs font-medium text-tp-link"
          onClick={() =>
            onForm({ ...form, demand: [...form.demand, { name: '', value: null, unit: '' }] })
          }
        >
          <MdAdd aria-hidden="true" className="h-4 w-4" /> Add a demand
        </button>

        {form.requireLimits.map((entry, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <label className="min-w-0">
              <span className={LABEL}>Limit at least</span>
              <select
                className={INPUT}
                value={entry.limit}
                onChange={event =>
                  onForm({
                    ...form,
                    requireLimits: form.requireLimits.map((item, at) =>
                      at === index ? { ...item, limit: event.target.value } : item
                    ),
                  })
                }
              >
                <option value="">Choose a limit</option>
                {[...new Set([...limits, entry.limit].filter(Boolean))].map(name => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0">
              <span className={LABEL}>The demand</span>
              <select
                className={INPUT}
                value={entry.atLeast}
                onChange={event =>
                  onForm({
                    ...form,
                    requireLimits: form.requireLimits.map((item, at) =>
                      at === index ? { ...item, atLeast: event.target.value } : item
                    ),
                  })
                }
              >
                <option value="">Choose a demand</option>
                {form.demand
                  .filter(item => item.name)
                  .map(item => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                      {item.value !== null
                        ? ` (${item.value}${item.unit ? ` ${item.unit}` : ''})`
                        : ''}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-tp-steel hover:bg-tp-surface"
              aria-label={`Remove the requirement on ${entry.limit || index + 1}`}
              onClick={() =>
                onForm({
                  ...form,
                  requireLimits: form.requireLimits.filter((_, at) => at !== index),
                })
              }
            >
              <MdDelete aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs font-medium text-tp-link"
          onClick={() =>
            onForm({ ...form, requireLimits: [...form.requireLimits, { limit: '', atLeast: '' }] })
          }
        >
          <MdAdd aria-hidden="true" className="h-4 w-4" /> Require a limit
        </button>
        <RequiredLimitsAssumed form={form} summaries={summaries} onSource={setSource} />

        {booleans.length > 0 && (
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className={LABEL}>Features a candidate must have</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {booleans.map(name => (
                <label key={name} className="inline-flex items-center gap-1.5 text-xs text-tp-ink">
                  <input
                    type="checkbox"
                    checked={form.requireFeatures.includes(name)}
                    onChange={() =>
                      onForm({
                        ...form,
                        requireFeatures: form.requireFeatures.includes(name)
                          ? form.requireFeatures.filter(item => item !== name)
                          : [...form.requireFeatures, name],
                      })
                    }
                  />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {problems.length > 0 && (
          <ul role="alert" className="flex flex-col gap-0.5 text-xs text-tp-error-text">
            {problems.map(problem => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        <label className="min-w-0 sm:max-w-xs">
          <span className={LABEL}>Dominated plans</span>
          <select
            className={INPUT}
            value={form.prune}
            onChange={event =>
              onForm({ ...form, prune: event.target.value as WizardForm['prune'] })
            }
          >
            <option value="none">Keep them</option>
            <option value="dominated">Leave them out</option>
          </select>
          <span className={HINT}>A plan left out now can break a binding in a later version.</span>
        </label>
      </section>
    </div>
  );
}

/** For a required limit a pricing does not declare, its own name for it or an explicit assumption. */
function RequiredLimitsAssumed({
  form,
  summaries,
  onSource,
}: {
  form: WizardForm;
  summaries: Record<string, VersionSummary>;
  onSource: (index: number, source: SourceForm) => void;
}) {
  const rows = form.requireLimits
    .filter(entry => entry.limit)
    .flatMap(entry => form.sources.map((source, index) => ({ limit: entry.limit, source, index })))
    .filter(
      ({ limit, source }) =>
        !declares(summaries[source.versionId], 'limit', source.names[limit] ?? limit)
    );
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-tp-severity-warning-border bg-tp-severity-warning-bg p-3">
      {rows.map(({ limit, source, index }) => (
        <MissingName
          key={`${limit}-${source.provider}`}
          kind="limit"
          name={limit}
          source={source}
          summary={summaries[source.versionId]}
          onSource={next => onSource(index, next)}
        />
      ))}
    </div>
  );
}

/** A pricing that does not declare a name: its own name for it, or (for a limit) an assumption recorded as set by hand. */
function MissingName({
  kind,
  name,
  source,
  summary,
  onSource,
}: {
  kind: SpecKind;
  name: string;
  source: SourceForm;
  summary: VersionSummary | undefined;
  onSource: (source: SourceForm) => void;
}) {
  const own = summary
    ? kind === 'limit'
      ? summary.usageLimits.map(limit => limit.name)
      : summary.features
          .filter(f => (kind === 'guarantee' ? f.type === 'GUARANTEE' : f.type !== 'GUARANTEE'))
          .map(f => f.name)
    : [];
  const assumed = source.assume[name];
  const choice = source.names[name]
    ? `name:${source.names[name]}`
    : assumed === 'unlimited'
      ? 'unlimited'
      : typeof assumed === 'number'
        ? 'number'
        : '';
  const set = (value: string) => {
    const names = { ...source.names };
    const assume = { ...source.assume };
    delete names[name];
    delete assume[name];
    if (value.startsWith('name:')) names[name] = value.slice(5);
    if (value === 'unlimited') assume[name] = 'unlimited';
    if (value === 'number') assume[name] = 0;
    onSource({ ...source, names, assume });
  };
  return (
    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr]">
      <label className="min-w-0">
        <span className={LABEL}>
          {source.title} does not declare {name}
        </span>
        <select className={INPUT} value={choice} onChange={event => set(event.target.value)}>
          <option value="">Choose</option>
          {own.map(option => (
            <option key={option} value={`name:${option}`}>
              It calls it {option}
            </option>
          ))}
          {kind === 'limit' && <option value="unlimited">Assume unlimited</option>}
          {kind === 'limit' && <option value="number">Assume a number</option>}
        </select>
      </label>
      {typeof assumed === 'number' && (
        <label className="min-w-0">
          <span className={LABEL}>Assumed {name}</span>
          <input
            className={INPUT}
            type="number"
            min={0}
            value={assumed}
            onChange={event =>
              onSource({
                ...source,
                assume: { ...source.assume, [name]: numberOrNull(event.target.value) ?? 0 },
              })
            }
          />
        </label>
      )}
    </div>
  );
}

function ManualValues({
  label,
  value,
  keys,
  onChange,
}: {
  label: string;
  value: ManualMap;
  keys: Array<{ key: string; label: string }>;
  onChange: (value: ManualMap) => void;
}) {
  return (
    <fieldset className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
      <legend className={LABEL}>{label}</legend>
      {keys.map(({ key, label: words }) => (
        <label key={key} className="min-w-0">
          <span className="mb-0.5 block text-[11px] text-tp-steel">{words}</span>
          <input
            className={INPUT}
            type="number"
            value={value[key] ?? ''}
            onChange={event => {
              const next = { ...value };
              const number = numberOrNull(event.target.value);
              if (number === null) delete next[key];
              else next[key] = number;
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

function FeatureMapping({
  feature,
  property,
  sources,
  summaries,
  names,
  editable,
  onFeature,
  onProperty,
  onSource,
  onRemove,
}: {
  feature: FeatureForm;
  property: PropertyForm;
  sources: SourceForm[];
  summaries: Record<string, VersionSummary>;
  names: string[];
  editable: boolean;
  onFeature: (feature: FeatureForm) => void;
  onProperty: (property: PropertyForm) => void;
  onSource: (index: number, source: SourceForm) => void;
  onRemove?: () => void;
}) {
  const reads =
    property.kind === 'limit' || property.kind === 'feature' || property.kind === 'guarantee';
  const providers = [...new Set(sources.map(source => source.provider))];
  const missing =
    reads && property.name
      ? sources
          .map((source, index) => ({ source, index }))
          .filter(
            ({ source }) =>
              !(source.provider in property.overrides) &&
              !declares(
                summaries[source.versionId],
                property.kind,
                source.names[property.name] ?? property.name
              )
          )
      : [];
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-tp-hairline p-3"
      data-feature={feature.id}
    >
      <div className="flex flex-wrap items-end gap-2">
        {editable ? (
          <>
            <label className="min-w-0 flex-1">
              <span className={LABEL}>Feature</span>
              <input
                className={INPUT}
                value={feature.id}
                onChange={event => onFeature({ ...feature, id: event.target.value })}
              />
            </label>
            <label className="w-32 min-w-0">
              <span className={LABEL}>Better when</span>
              <select
                className={INPUT}
                value={feature.direction}
                onChange={event =>
                  onFeature({
                    ...feature,
                    direction: event.target.value as FeatureForm['direction'],
                  })
                }
              >
                <option value="minimize">lower</option>
                <option value="maximize">higher</option>
              </select>
            </label>
            <label className="w-32 min-w-0">
              <span className={LABEL}>Unit</span>
              <input
                className={INPUT}
                value={feature.unit}
                onChange={event => onFeature({ ...feature, unit: event.target.value })}
              />
            </label>
          </>
        ) : (
          <p className="flex-1 text-sm font-semibold text-tp-ink">
            <code className="font-mono">{feature.id}</code>
            {feature.unit && (
              <span className="ml-1 font-normal text-tp-steel">({feature.unit})</span>
            )}
          </p>
        )}
        <label className="min-w-0 flex-1">
          <span className={LABEL}>{`Read ${feature.id} from`}</span>
          <select
            className={INPUT}
            value={property.kind}
            onChange={event =>
              onProperty({
                ...emptyProperty(event.target.value as SpecKind),
                overrides: property.overrides,
              })
            }
          >
            {(Object.keys(KIND_LABEL) as SpecKind[]).map(kind => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
        {onRemove && (
          <button
            type="button"
            className="mb-1 inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-tp-steel hover:bg-tp-surface"
            aria-label={`Remove the feature ${feature.id}`}
            onClick={onRemove}
          >
            <MdDelete aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>

      {reads && (
        <label className="min-w-0 sm:max-w-sm">
          <span className={LABEL}>{`The ${property.kind} ${feature.id} reads`}</span>
          <select
            className={INPUT}
            value={property.name}
            onChange={event => onProperty({ ...property, name: event.target.value })}
          >
            <option value="">Choose one</option>
            {[...new Set([...names, property.name].filter(Boolean))].map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {property.kind === 'guarantee' && property.name && (
        <div className="flex flex-col gap-2">
          <label className="inline-flex items-center gap-1.5 text-xs text-tp-ink">
            <input
              type="checkbox"
              checked={property.useScale}
              onChange={() => onProperty({ ...property, useScale: !property.useScale })}
            />
            The guarantee is a number: scale it instead of a table
          </label>
          {property.useScale ? (
            <label className="min-w-0 sm:max-w-xs">
              <span className={LABEL}>Multiply by</span>
              <input
                className={INPUT}
                type="number"
                value={property.scale ?? ''}
                onChange={event =>
                  onProperty({ ...property, scale: numberOrNull(event.target.value) })
                }
              />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
              {(['true', 'false'] as const).map(word => (
                <label key={word} className="min-w-0">
                  <span
                    className={LABEL}
                  >{`When ${property.name} is ${word === 'true' ? 'yes' : 'no'}`}</span>
                  <input
                    className={INPUT}
                    type="number"
                    value={property.map[word] ?? ''}
                    onChange={event =>
                      onProperty({
                        ...property,
                        map: { ...property.map, [word]: numberOrNull(event.target.value) },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {property.kind === 'limit' && property.name && (
        <label className="min-w-0 sm:max-w-xs">
          <span className={LABEL}>An unlimited {property.name} counts as</span>
          <input
            className={INPUT}
            type="number"
            value={property.unlimitedAs ?? ''}
            onChange={event =>
              onProperty({ ...property, unlimitedAs: numberOrNull(event.target.value) })
            }
          />
        </label>
      )}
      {property.kind === 'constant' && (
        <label className="min-w-0 sm:max-w-xs">
          <span className={LABEL}>{`${feature.id} of every candidate`}</span>
          <input
            className={INPUT}
            type="number"
            value={property.constant ?? ''}
            onChange={event =>
              onProperty({ ...property, constant: numberOrNull(event.target.value) })
            }
          />
        </label>
      )}
      {property.kind === 'manual' && (
        <ManualValues
          label={`${feature.id} by hand`}
          value={property.manual}
          keys={[
            { key: '*', label: 'Every candidate' },
            ...providers.map(provider => ({ key: provider, label: `Every ${provider} plan` })),
          ]}
          onChange={manual => onProperty({ ...property, manual })}
        />
      )}
      {missing.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-tp-severity-warning-border bg-tp-severity-warning-bg p-3">
          {missing.map(({ source, index }) => (
            <div key={source.provider} className="flex flex-col gap-2">
              <MissingName
                kind={property.kind}
                name={property.name}
                source={source}
                summary={summaries[source.versionId]}
                onSource={next => onSource(index, next)}
              />
              {property.kind !== 'limit' && (
                <button
                  type="button"
                  className="w-fit cursor-pointer text-xs font-medium text-tp-link"
                  onClick={() =>
                    onProperty({
                      ...property,
                      overrides: { ...property.overrides, [source.provider]: { '*': 0 } },
                    })
                  }
                >
                  {`Set ${feature.id} by hand for ${source.provider} instead`}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {Object.entries(property.overrides).map(([provider, manual]) => (
        <div key={provider} className="flex flex-col gap-1">
          <ManualValues
            label={`${feature.id} by hand for ${provider}`}
            value={manual}
            keys={[{ key: '*', label: `Every ${provider} plan` }]}
            onChange={next =>
              onProperty({ ...property, overrides: { ...property.overrides, [provider]: next } })
            }
          />
          <button
            type="button"
            className="w-fit cursor-pointer text-xs font-medium text-tp-link"
            onClick={() => {
              const overrides = { ...property.overrides };
              delete overrides[provider];
              onProperty({ ...property, overrides });
            }}
          >
            {`Read ${provider} like the others`}
          </button>
        </div>
      ))}
    </div>
  );
}

function AddFeature({ taken, onAdd }: { taken: string[]; onAdd: (feature: FeatureForm) => void }) {
  const [name, setName] = useState('');
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !taken.includes(name);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1">
        <span className={LABEL}>New feature</span>
        <input
          className={INPUT}
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder="e.g. availability"
        />
      </label>
      <button
        type="button"
        disabled={!valid}
        className="mb-0.5 inline-flex h-10 cursor-pointer items-center gap-1 rounded-lg border border-tp-hairline-strong px-3 text-xs font-medium text-tp-ink hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          onAdd({ id: name, direction: 'minimize', unit: '', domain: 'real' });
          setName('');
        }}
      >
        <MdAdd aria-hidden="true" className="h-4 w-4" /> Add feature
      </button>
    </div>
  );
}
