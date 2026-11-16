import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import {
  RESOURCE_ROLE_LABELS,
  instanceResources,
  parseJson,
  pretty,
  registeredResourceLabel,
  type BimDocument,
  type WorkspaceFiles,
} from './documents';
import { CommonResourceForm } from './forms/ResourceForms';
import { packageContext } from './packageContext';

interface FormsPaneProps {
  files: WorkspaceFiles;
  path: string;
  onPath: (path: string) => void;
  /** Change the files as one undo step. */
  update: (updater: (current: WorkspaceFiles) => WorkspaceFiles) => void;
  /** Show a file of the package as text (a BPMN file is drawn, not a form). */
  onOpenFile: (path: string) => void;
}

/**
 * The documents of the package as forms: the index of its resources by role, and the selected document's form, which writes the
 * document back as one undo step.
 */
export function FormsPane({ files, path, onPath, update, onOpenFile }: FormsPaneProps) {
  const root = parseJson(files['instance.json']);
  const resources = instanceResources(root, files);
  const selected = path in files ? path : 'instance.json';
  const document = parseJson(files[selected]);
  const resource = resources.find(item => item.path === selected);
  const kind =
    selected === 'instance.json' ? 'Instance' : resource?.kind || document?.kind || 'File';
  const groups = [...new Set(resources.map(item => item.role))].map(role => ({
    role,
    entries: resources.filter(item => item.role === role),
  }));
  const paths = Object.keys(files).filter(
    file => file !== 'instance.json' && /\.(?:json|bpmn|xml)$/i.test(file)
  );
  // The forms write parts that must agree with the other documents of the package (a provider the catalog declares, a feature the
  // Application declares, a penalty the Optimization lists); this is what they read to do it.
  const context = packageContext(files, resources, selected, { open: onPath, update });
  const write = (next: BimDocument) =>
    update(current => ({ ...current, [selected]: pretty(next) }));

  return (
    <div className="pe-forms">
      <nav className="pe-index" aria-label="BIM resources">
        <button
          type="button"
          className={selected === 'instance.json' ? 'is-selected' : undefined}
          aria-current={selected === 'instance.json' ? 'true' : undefined}
          onClick={() => onPath('instance.json')}
        >
          <span>Instance root</span>
          <code>instance.json</code>
        </button>
        {groups.map(({ role, entries }) => (
          <section key={role}>
            <h3>{RESOURCE_ROLE_LABELS[role] || role}</h3>
            {entries.map(entry =>
              entry.path ? (
                <button
                  type="button"
                  key={`${role}/${entry.id}`}
                  className={selected === entry.path ? 'is-selected' : undefined}
                  aria-current={selected === entry.path ? 'true' : undefined}
                  onClick={() => onPath(entry.path!)}
                >
                  <span>{entry.kind}</span>
                  <strong>{entry.id}</strong>
                  <code>{entry.path}</code>
                </button>
              ) : (
                <div className="pe-index-registered" key={`${role}/${entry.id}`}>
                  <span>{entry.kind}</span>
                  <strong>{entry.id}</strong>
                  <code>
                    {entry.registered
                      ? registeredResourceLabel(entry.registered)
                      : 'invalid target'}
                  </code>
                </div>
              )
            )}
          </section>
        ))}
      </nav>
      <div className="pe-form">
        <div className="pe-form-head">
          <Chip tone="accent">{kind}</Chip>
          <code>{selected}</code>
        </div>
        {/\.(bpmn|xml)$/i.test(selected) ? (
          <Notice tone="info">{`${selected} is a diagram: draw it in the BPMN pane, or edit its XML in Files.`}</Notice>
        ) : document ? (
          <CommonResourceForm
            document={document}
            onChange={write}
            availablePaths={paths}
            context={context}
          />
        ) : (
          <Notice
            tone="error"
            action={
              <button type="button" className="pe-link" onClick={() => onOpenFile(selected)}>
                Open {selected} in Files
              </button>
            }
          >
            {`${selected} is not a JSON document right now, so it has no form. Repair its text in Files.`}
          </Notice>
        )}
      </div>
    </div>
  );
}
