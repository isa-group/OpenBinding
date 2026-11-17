import { Chip } from '../../../core/components/chip';
import { Notice } from '../../../core/components/notice';
import {
  RESOURCE_ROLE_LABELS,
  instanceResources,
  parseJson,
  pretty,
  registeredResourceLabel,
  type BimDocument,
  type WorkspaceFiles,
} from '../../utils/documents';
import { CommonResourceForm } from '../resource-forms';
import { packageContext } from '../../utils/packageContext';
import { FORM_HEAD, LINK } from '../../utils/styles';

const ENTRY =
  'flex min-h-8 w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-md border-l-[3px] px-2.5 py-1.5 text-left text-[13px] text-tp-ink [&>code]:font-mono [&>code]:[overflow-wrap:anywhere] [&>span]:text-[11px] [&>span]:text-tp-steel';
/** An entry of the index: the selected one marked on its left edge. */
const entry = (selected: boolean) =>
  selected
    ? `${ENTRY} border-l-tp-primary bg-tp-surface-cream text-tp-primary-deep`
    : `${ENTRY} border-l-transparent hover:bg-tp-surface`;

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
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(180px,15rem)_minmax(0,1fr)]">
      <nav
        className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-tp-hairline-soft bg-tp-canvas p-1.5 lg:max-h-[560px]"
        aria-label="BIM resources"
      >
        <button
          type="button"
          className={entry(selected === 'instance.json')}
          aria-current={selected === 'instance.json' ? 'true' : undefined}
          onClick={() => onPath('instance.json')}
        >
          <span>Instance root</span>
          <code>instance.json</code>
        </button>
        {groups.map(({ role, entries }) => (
          <section key={role} className="flex flex-col gap-0.5">
            <h3 className="mx-2 mt-2 mb-0.5 text-[11px] font-semibold tracking-[0.1em] text-tp-steel uppercase">
              {RESOURCE_ROLE_LABELS[role] || role}
            </h3>
            {entries.map(item =>
              item.path ? (
                <button
                  type="button"
                  key={`${role}/${item.id}`}
                  className={entry(selected === item.path)}
                  aria-current={selected === item.path ? 'true' : undefined}
                  onClick={() => onPath(item.path!)}
                >
                  <span>{item.kind}</span>
                  <strong>{item.id}</strong>
                  <code>{item.path}</code>
                </button>
              ) : (
                <div
                  className={`${ENTRY} cursor-default border-l-transparent text-tp-slate`}
                  key={`${role}/${item.id}`}
                >
                  <span>{item.kind}</span>
                  <strong>{item.id}</strong>
                  <code>
                    {item.registered ? registeredResourceLabel(item.registered) : 'invalid target'}
                  </code>
                </div>
              )
            )}
          </section>
        ))}
      </nav>
      <div className="flex min-w-0 flex-col gap-2">
        <div className={FORM_HEAD}>
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
              <button type="button" className={LINK} onClick={() => onOpenFile(selected)}>
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
