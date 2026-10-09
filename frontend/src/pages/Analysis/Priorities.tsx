import type { ArchiveQuery, ArchiveResponse, DecisionRule } from '../../analysis/archive';
import { Action } from '../../components/ui/Action';
import { OBJECTIVE_COLOURS, RULES, activeDimensions, counted, percent } from './analysisModel';

interface PrioritiesProps {
  data: ArchiveResponse;
  query: ArchiveQuery;
  change: (values: Partial<ArchiveQuery>) => void;
}

/**
 * The left column of the decision space: how much each objective matters, which limits must hold, and the rule that turns both into a
 * recommendation. Every control asks the gateway again; the figures beside them are the shares it computed, never a guess of the page.
 */
export function Priorities({ data, query, change }: PrioritiesProps) {
  const active = activeDimensions(data.dimensions);
  const constant = data.dimensions.filter((dimension) => dimension.constant);
  const reference = query.rule === 'reference';

  const setWeight = (key: string, value: number) => {
    if (Number.isFinite(value) && value >= 0) change({ weights: { ...query.weights, [key]: value }, page: 0 });
  };
  const setLimit = (key: string, text: string, value: number) => {
    const requirements = (query.requirements ?? []).filter((requirement) => requirement.dimension !== key);
    if (text !== '' && Number.isFinite(value)) {
      requirements.push({ dimension: key, value, space: query.requirements?.find((requirement) => requirement.dimension === key)?.space ?? 'raw' });
    }
    change({ requirements, page: 0 });
  };

  return (
    <aside className="an-side" aria-label="Priorities and requirements">
      <section className="an-card" aria-labelledby="an-priorities-title">
        <h2 id="an-priorities-title">Priorities</h2>
        {active.map((dimension) => (
          <label key={dimension.key} className="an-slider">
            <span><span>{dimension.label} matters</span> <strong>{percent(data.weights[dimension.key] ?? 0)}</strong></span>
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={query.weights?.[dimension.key] ?? 1}
              aria-label={`${dimension.label} priority`}
              onChange={(event) => setWeight(dimension.key, event.target.valueAsNumber)}
            />
          </label>
        ))}
        <div className="an-share" role="img" aria-label={active.map((dimension) => `${dimension.label} ${percent(data.weights[dimension.key] ?? 0)}`).join(', ')}>
          {active.map((dimension) => (
            <span key={dimension.key} style={{ width: `${(data.weights[dimension.key] ?? 0) * 100}%`, background: OBJECTIVE_COLOURS[data.dimensions.indexOf(dimension) % OBJECTIVE_COLOURS.length] }} />
          ))}
        </div>
        <ul className="an-legend" aria-hidden="true">
          {active.map((dimension) => (
            <li key={dimension.key}>
              <i style={{ background: OBJECTIVE_COLOURS[data.dimensions.indexOf(dimension) % OBJECTIVE_COLOURS.length] }} />
              {dimension.label} {percent(data.weights[dimension.key] ?? 0)}
            </li>
          ))}
        </ul>
        <small className="an-note">Equal priority is the starting assumption. Scores are normalised once for these results, so they stay comparable when requirements change.</small>
        {constant.length > 0 && <small className="an-note">Constant in these results, so they cannot be traded off: {constant.map((dimension) => dimension.label).join(', ')}.</small>}
      </section>

      <section className="an-card" aria-labelledby="an-limits-title">
        <h2 id="an-limits-title">Must hold</h2>
        {data.dimensions.map((dimension) => {
          const requirement = query.requirements?.find((item) => item.dimension === dimension.key);
          const atLeast = requirement?.space !== 'normalized' && dimension.direction === 'maximize';
          return (
            <div key={dimension.key} className="an-limit">
              <label>
                <span>{dimension.label} {atLeast ? 'at least' : 'at most'}{dimension.unit ? ` (${dimension.unit})` : ''}</span>
                <input
                  type="number"
                  step="any"
                  inputMode="decimal"
                  placeholder="No limit"
                  aria-label={`${dimension.label} requirement`}
                  value={requirement?.value ?? ''}
                  onChange={(event) => setLimit(dimension.key, event.target.value, event.target.valueAsNumber)}
                />
              </label>
              {requirement && (
                <label>
                  <span>Units of the limit</span>
                  <select
                    aria-label={`${dimension.label} requirement units`}
                    value={requirement.space}
                    onChange={(event) => change({ requirements: query.requirements?.map((item) => (item.dimension === dimension.key ? { ...item, space: event.target.value as 'raw' | 'normalized' } : item)), page: 0 })}
                  >
                    <option value="raw">Stored raw units</option>
                    <option value="normalized">Normalised loss, 0–1</option>
                  </select>
                </label>
              )}
              {reference && (
                <label>
                  <span>Target on the 0–1 scale</span>
                  <input
                    type="number"
                    step="0.1"
                    value={query.reference?.[dimension.key] ?? 0}
                    onChange={(event) => { if (Number.isFinite(event.target.valueAsNumber)) change({ reference: { ...query.reference, [dimension.key]: event.target.valueAsNumber } }); }}
                  />
                </label>
              )}
            </div>
          );
        })}
        <small className="an-note">Includes the limit itself. {counted(data.counts.eligible)} of {counted(data.counts.unique)} bindings meet every requirement.</small>
      </section>

      <section className="an-card" aria-labelledby="an-rule-title">
        <h2 id="an-rule-title">Rule</h2>
        <label className="an-field">
          <span>Recommendation rule</span>
          <select value={query.rule ?? 'balanced'} onChange={(event) => change({ rule: event.target.value as DecisionRule, page: 0, geometry: 'none' })}>
            {Object.entries(RULES).map(([value, label]) => (
              <option key={value} value={value} disabled={value === 'model' && !data.modelOrderingAvailable}>
                {label}{value === 'model' && !data.modelOrderingAvailable ? ' (partial order only)' : ''}
              </option>
            ))}
          </select>
        </label>
        <small className="an-note">{data.formula}</small>
        <Action variant="secondary" size="sm" onClick={() => change({ weights: {}, requirements: [], reference: {}, page: 0 })}>Reset priorities and requirements</Action>
      </section>
    </aside>
  );
}
