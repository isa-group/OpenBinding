import type { FormEvent } from 'react';
import { FileText } from 'lucide-react';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';

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
