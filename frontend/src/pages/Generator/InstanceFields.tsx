import { FormField } from '../../components/ui/FormField';
import { ENGINE_CHOICES, SPREADS, latencyHistogram, type FieldErrors, type LabSettings, type Spread } from './generatorModel';

interface InstanceFieldsProps {
  settings: LabSettings;
  errors: FieldErrors;
  onChange: (patch: Partial<LabSettings>) => void;
  /** Hide the fields of the batch tool that the single instance does not have, or the other way round. */
  tool: 'instance' | 'corpus';
}

/** A number the field holds, or a default when it is still being typed. */
const shape = (text: string, fallback: number): number => (text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : fallback);

/** The settings of one synthetic instance: its size, the seed that makes it repeatable and how fast its providers are. */
export function InstanceFields({ settings, errors, onChange, tool }: InstanceFieldsProps) {
  const low = shape(settings.latencyMin, 50);
  const high = shape(settings.latencyMax, 300);
  const bars = latencyHistogram(settings.spread, low, high > low ? high : low + 1);
  const toggleEngine = (engine: string) => onChange({
    engines: settings.engines.includes(engine) ? settings.engines.filter((item) => item !== engine) : [...settings.engines, engine],
  });

  return (
    <>
      <div className="gl-grid">
        <FormField label="Tasks" type="number" inputMode="numeric" min={2} max={1000} value={settings.tasks} error={errors.tasks} hint="Activities in the workflow." onChange={(event) => onChange({ tasks: event.target.value })} />
        <FormField label="Candidates per task" type="number" inputMode="numeric" min={2} max={100} value={settings.candidates} error={errors.candidates} hint="Providers to choose from." onChange={(event) => onChange({ candidates: event.target.value })} />
        <FormField label="Random seed" mono inputMode="numeric" value={settings.seed} error={errors.seed} hint="The same seed gives the same instance." onChange={(event) => onChange({ seed: event.target.value })} />
        {tool === 'corpus' && (
          <FormField label="How many instances" type="number" inputMode="numeric" min={1} max={100} value={settings.count} error={errors.count} hint="Between 1 and 100." onChange={(event) => onChange({ count: event.target.value })} />
        )}
      </div>

      <fieldset className="gl-fieldset">
        <legend>Latency of generated providers</legend>
        <div className="gl-pills" role="radiogroup" aria-label="Distribution">
          {SPREADS.map((spread) => (
            <label key={spread.id} className={`gl-pill${settings.spread === spread.id ? ' is-checked' : ''}`}>
              <input type="radio" name="gl-spread" value={spread.id} checked={settings.spread === spread.id} onChange={() => onChange({ spread: spread.id as Spread })} />
              {spread.label}
            </label>
          ))}
        </div>
        <div className="gl-range">
          <FormField label="From (ms)" inputMode="numeric" value={settings.latencyMin} error={errors.latencyMin} maxWidth="160px" onChange={(event) => onChange({ latencyMin: event.target.value })} />
          <FormField label="To (ms)" inputMode="numeric" value={settings.latencyMax} error={errors.latencyMax} maxWidth="160px" onChange={(event) => onChange({ latencyMax: event.target.value })} />
        </div>
        <div className="gl-hist" role="img" aria-label={`How the latency of the providers is spread between ${low} and ${high} milliseconds`}>
          {bars.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
        </div>
      </fieldset>

      <details className="gl-advanced">
        <summary>Advanced settings</summary>
        <div className="gl-advanced-body">
          <div className="gl-grid">
            <FormField label="Instance name" value={settings.name} onChange={(event) => onChange({ name: event.target.value })} />
            <FormField label="Control flow (%)" type="number" inputMode="numeric" min={0} max={90} value={settings.controlFlow} error={errors.controlFlow} hint="Share of activities that are control flow." onChange={(event) => onChange({ controlFlow: event.target.value })} />
            <FormField label="Loops (%)" type="number" inputMode="numeric" min={0} max={100} value={settings.loops} error={errors.loops} onChange={(event) => onChange({ loops: event.target.value })} />
            <FormField label="Branches (%)" type="number" inputMode="numeric" min={0} max={100} value={settings.branches} error={errors.branches} onChange={(event) => onChange({ branches: event.target.value })} />
            <FormField label="Parallel flows (%)" type="number" inputMode="numeric" min={0} max={100} value={settings.parallel} error={errors.parallel} onChange={(event) => onChange({ parallel: event.target.value })} />
            <FormField label="Nesting depth" type="number" inputMode="numeric" min={1} max={10} value={settings.maxNesting} error={errors.maxNesting} onChange={(event) => onChange({ maxNesting: event.target.value })} />
            <FormField label="Rules" type="number" inputMode="numeric" min={0} max={100} value={settings.constraints} error={errors.constraints} hint="Quality limits to satisfy." onChange={(event) => onChange({ constraints: event.target.value })} />
            <label className="gl-field">
              <span>Rule tightness: {Number(settings.tension || 0).toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={settings.tension} onChange={(event) => onChange({ tension: event.target.value })} />
              {errors.tension && <span className="gl-error">{errors.tension}</span>}
            </label>
            <label className="gl-field">
              <span>Goal</span>
              <select value={settings.optimization} onChange={(event) => onChange({ optimization: event.target.value as LabSettings['optimization'] })}>
                <option value="weighted">Weighted (one objective)</option>
                <option value="pareto">Pareto (several objectives)</option>
              </select>
            </label>
          </div>
          <fieldset className="gl-fieldset">
            <legend>Engines it should suit</legend>
            <div className="gl-checks">
              {ENGINE_CHOICES.map((engine) => (
                <label key={engine}><input type="checkbox" checked={settings.engines.includes(engine)} onChange={() => toggleEngine(engine)} /><code>{engine}</code></label>
              ))}
            </div>
            <label className="gl-check-line">
              <input type="checkbox" checked={settings.guarantee} onChange={(event) => onChange({ guarantee: event.target.checked })} />
              <span><b>Guarantee feasibility.</b> Keep a hidden solution so the problem always has an answer.</span>
            </label>
          </fieldset>
        </div>
      </details>
    </>
  );
}
