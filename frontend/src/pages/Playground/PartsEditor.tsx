/**
 * An instance shown as what it is made of, rather than as one document.
 *
 * A BIM instance is I' = (M_A, M'_C, Delta, O), and every component of that
 * tuple can be written, read and reused on its own: the same application over
 * several infrastructures, the same infrastructure under several objectives.
 * Editing it here works the same way - one editor per part, grouped by the
 * model it belongs to - so the separation the language is built on is visible
 * instead of implied.
 *
 * The gateway owns which key belongs to which part; this asks it rather than
 * keeping a second copy of that map.
 */

import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { CodeEditor } from '../../components/CodeEditor/CodeEditor';
import './PartsEditor.css';

/** What each group of parts is, in the language of the paper. */
const GROUP_LABELS: Record<string, { title: string; subtitle: string }> = {
  M_A: { title: 'M_A', subtitle: 'The application: its tasks, their orchestration, how features aggregate' },
  M_C: { title: "M'_C", subtitle: 'What can run it: providers, candidates, features, resources, latency' },
  Delta: { title: 'Δ', subtitle: 'What a binding must satisfy' },
  O: { title: 'O', subtitle: 'How eligible bindings are ranked' },
  other: { title: 'Outside the tuple', subtitle: 'Description, and the per-instance normalization overlay' },
};

const GROUP_ORDER = ['M_A', 'M_C', 'Delta', 'O', 'other'];

/** A one-line reading of what a part contains, shown next to its name. */
function summarize(content: unknown): string {
  if (content === undefined || content === null) return 'empty';
  if (Array.isArray(content)) return `${content.length} ${content.length === 1 ? 'entry' : 'entries'}`;
  if (typeof content === 'object') {
    const values = Object.values(content as Record<string, unknown>);
    if (values.length === 1) return summarize(values[0]);
    return `${values.length} keys`;
  }
  return String(content);
}

export interface PartsEditorProps {
  /** Part name to its JSON text, as edited. */
  parts: Record<string, string>;
  /** Which model each part belongs to, from the gateway. */
  groups: Record<string, string[]>;
  onChange: (partName: string, value: string) => void;
  /** Parts whose content the composed instance was rejected over. */
  partsInError?: Record<string, string>;
}

export function PartsEditor({ parts, groups, onChange, partsInError = {} }: PartsEditorProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const orderedGroups = useMemo(() => {
    const known = GROUP_ORDER.filter((name) => groups[name]?.length);
    const rest = Object.keys(groups).filter((name) => !GROUP_ORDER.includes(name));
    return [...known, ...rest];
  }, [groups]);

  const parsedSummary = (partName: string): string => {
    const text = parts[partName];
    if (!text) return 'empty';
    try {
      return summarize(JSON.parse(text));
    } catch {
      return 'not JSON yet';
    }
  };

  const toggle = (partName: string) =>
    setCollapsed((current) => ({ ...current, [partName]: !current[partName] }));

  return (
    <div className="parts-editor">
      {orderedGroups.map((groupName) => {
        const label = GROUP_LABELS[groupName] ?? { title: groupName, subtitle: '' };
        const present = (groups[groupName] || []).filter((partName) => partName in parts);
        if (present.length === 0) return null;

        return (
          <section key={groupName} className="parts-group">
            <header className="parts-group-header">
              <span className="parts-group-title">{label.title}</span>
              <span className="parts-group-subtitle">{label.subtitle}</span>
            </header>

            {present.map((partName) => {
              const isCollapsed = collapsed[partName];
              const errorMessage = partsInError[partName];
              return (
                <article
                  key={partName}
                  className={`part-card${errorMessage ? ' part-card-error' : ''}`}
                >
                  <button
                    type="button"
                    className="part-header"
                    onClick={() => toggle(partName)}
                    aria-expanded={!isCollapsed}
                  >
                    <span className="part-chevron">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="part-name">{partName}.json</span>
                    <Badge variant={errorMessage ? 'error' : 'default'} size="sm">
                      {errorMessage ? 'invalid' : parsedSummary(partName)}
                    </Badge>
                  </button>

                  {errorMessage && <p className="part-error">{errorMessage}</p>}

                  {!isCollapsed && (
                    <CodeEditor
                      value={parts[partName]}
                      onChange={(value) => onChange(partName, value)}
                      minHeight="80px"
                      maxHeight="320px"
                    />
                  )}
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
