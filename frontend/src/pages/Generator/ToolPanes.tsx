import type { FormEvent } from 'react';
import { FileText, Lock } from 'lucide-react';
import type { EngineCalibratedResponse } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Notice } from '../../components/ui/Notice';

export interface LegacyState {
  text: string;
  fileName: string;
  name: string;
  repair: boolean;
  guarantee: boolean;
  tension: string;
}

interface ConvertPaneProps {
  legacy: LegacyState;
  onChange: (patch: Partial<LegacyState>) => void;
  busy: boolean;
  error: string | null;
  onSubmit: (event: FormEvent) => void;
}

/** Turn an instance in the older research format into a package: from a file, or pasted. */
export function ConvertPane({ legacy, onChange, busy, error, onSubmit }: ConvertPaneProps) {
  return (
    <form className="gl-card gl-form" onSubmit={onSubmit} noValidate>
      <p className="gl-lede">Turn an instance in the older research format into a BIM package you can validate and run.</p>
      <label className="gl-drop">
        <FileText aria-hidden="true" />
        <strong>{legacy.fileName ? `Loaded ${legacy.fileName}` : 'Drop an old-format instance'}</strong>
        <span className="ui-action is-secondary is-md">
          <span>Choose file</span>
          <input
            className="sr-only"
            type="file"
            aria-label="Old-format instance file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then((text) => onChange({ text, fileName: file.name }));
              event.currentTarget.value = '';
            }}
          />
        </span>
      </label>
      <label className="gl-field">
        <span>Or paste its text</span>
        <textarea rows={7} value={legacy.text} spellCheck={false} placeholder="Task definitions, QoS tables and the structure of the workflow…" onChange={(event) => onChange({ text: event.target.value, fileName: '' })} />
      </label>
      <div className="gl-grid">
        <FormField label="Name of the package" value={legacy.name} onChange={(event) => onChange({ name: event.target.value })} />
        <label className="gl-field">
          <span>Rule tightness: {Number(legacy.tension || 0).toFixed(2)}</span>
          <input type="range" min={0} max={1} step={0.05} value={legacy.tension} onChange={(event) => onChange({ tension: event.target.value })} />
        </label>
      </div>
      <div className="gl-checks">
        <label><input type="checkbox" checked={legacy.repair} onChange={(event) => onChange({ repair: event.target.checked })} />Repair empty branches in the structure</label>
        <label><input type="checkbox" checked={legacy.guarantee} onChange={(event) => onChange({ guarantee: event.target.checked })} />Keep a hidden solution so it always has an answer</label>
      </div>
      {error && <div className="gl-alert" role="alert">{error}</div>}
      <Action type="submit" variant="primary" busy={busy} disabled={!legacy.text.trim()}>Convert to a package</Action>
    </form>
  );
}

interface CalibratePaneProps {
  isAdmin: boolean;
  engines: string[];
  engine: string;
  mode: string;
  observationsText: string;
  fileName: string;
  busy: boolean;
  error: string | null;
  result: EngineCalibratedResponse | null;
  onChange: (patch: { engine?: string; mode?: string; observationsText?: string; fileName?: string }) => void;
  onSubmit: (event: FormEvent) => void;
}

function Coefficients({ title, values }: { title: string; values: Record<string, number> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  return (
    <table className="gl-coefficients">
      <caption>{title}</caption>
      <tbody>{entries.map(([name, amount]) => <tr key={name}><th scope="row">{name}</th><td>{Number(amount).toPrecision(4)}</td></tr>)}</tbody>
    </table>
  );
}

/** Refit the model that predicts how an engine behaves. It changes something shared by everyone, so the lab offers it to platform administrators only. */
export function CalibratePane({ isAdmin, engines, engine, mode, observationsText, fileName, busy, error, result, onChange, onSubmit }: CalibratePaneProps) {
  return (
    <div className="gl-card gl-form">
      <div className="gl-tbc" role="note">
        <span>Calibrating changes the shared model that predicts how engines behave, for everyone.</span>
      </div>
      {!isAdmin && <p className="gl-locked"><Lock aria-hidden="true" />Only platform administrators can calibrate.</p>}
      {isAdmin && (
        <form className="gl-form" onSubmit={onSubmit} noValidate>
          <div className="gl-grid">
            <label className="gl-field">
              <span>Engine</span>
              {engines.length > 0 ? (
                <select value={engine} onChange={(event) => onChange({ engine: event.target.value })}>
                  <option value="">Choose an engine…</option>
                  {engines.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              ) : (
                <input value={engine} placeholder="Engine name" onChange={(event) => onChange({ engine: event.target.value })} />
              )}
            </label>
            <FormField label="Mode" value={mode} mono onChange={(event) => onChange({ mode: event.target.value })} />
          </div>
          <label className="gl-drop is-compact">
            <strong>{fileName ? `Observed runs: ${fileName}` : 'Observed runs (a JSON file)'}</strong>
            <span className="ui-action is-secondary is-md">
              <span>Choose file</span>
              <input
                className="sr-only"
                type="file"
                accept=".json,application/json"
                aria-label="Observed runs file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void file.text().then((text) => onChange({ observationsText: text, fileName: file.name }));
                  event.currentTarget.value = '';
                }}
              />
            </span>
          </label>
          <label className="gl-field">
            <span>Or paste the runs as JSON</span>
            <textarea rows={5} value={observationsText} spellCheck={false} placeholder='[{"workload_features": {}, "latency": 12.5, "quality": 0.9, "success": true}]' onChange={(event) => onChange({ observationsText: event.target.value, fileName: '' })} />
          </label>
          <p className="gl-muted">Without runs, none are sent and the server decides what to fit.</p>
          {error && <div className="gl-alert" role="alert">{error}</div>}
          <Action type="submit" variant="primary" busy={busy} disabled={!engine.trim()}>Calibrate</Action>
          {result && (
            <Notice tone="success" title="Calibration summary">
              {`${result.engine} · ${result.mode}: fitted on ${result.sample_count} run${result.sample_count === 1 ? '' : 's'} (R² ${Number(result.r2_score).toFixed(3)}, ${result.status}).`}
            </Notice>
          )}
          {result && (
            <div className="gl-coefficient-grid">
              <Coefficients title="Run time" values={result.latency_coefficients} />
              <Coefficients title="Quality" values={result.quality_coefficients} />
              <Coefficients title="Risk of failing" values={result.failure_risk_coefficients} />
            </div>
          )}
        </form>
      )}
    </div>
  );
}
