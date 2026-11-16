import type { ReactNode } from 'react';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import type { ProblemFacts } from '../../modules/core/api/types';
import {
  RulesAndObjectives,
  type RuleOrigin,
} from '../../widgets/rules-and-objectives/RulesAndObjectives';
import {
  instanceResources,
  parseJson,
  pretty,
  type BimSpecDocument,
  type ResourceEntry,
  type WorkspaceFiles,
} from './documents';
import { ConstraintSetForm, OptimizationForm, type SpecProps } from './forms/ResourceForms';
import { NotChecked, StaleNote } from './ModelPanes';
import { packageContext } from './packageContext';

interface RulesPaneProps {
  facts: ProblemFacts | null;
  stale: boolean;
  files: WorkspaceFiles;
  /** Change the files as one undo step. */
  update: (updater: (current: WorkspaceFiles) => WorkspaceFiles) => void;
  /** Open a rule where the package writes it (the file at the rule's range). */
  onOpenOrigin: (origin: RuleOrigin) => void;
  onOpenFile: (path: string) => void;
}

/** The form of one document of the package, written back as one undo step; a document that does not parse sends to Files. */
function DocumentForm({
  kind,
  entry,
  files,
  update,
  onOpenFile,
  Form,
}: {
  kind: 'ConstraintSet' | 'Optimization';
  entry: ResourceEntry & { path: string };
  files: WorkspaceFiles;
  update: RulesPaneProps['update'];
  onOpenFile: (path: string) => void;
  Form: (props: SpecProps) => ReactNode;
}) {
  const document = parseJson(files[entry.path]);
  const resources = instanceResources(parseJson(files['instance.json']), files);
  const context = packageContext(files, resources, entry.path, { open: onOpenFile, update });
  const updateSpec = (spec: BimSpecDocument) =>
    update(current => ({ ...current, [entry.path]: pretty({ ...document, spec }) }));
  return (
    <section className="pe-rules-document" aria-label={`${kind} ${entry.id}`}>
      <div className="pe-form-head">
        <Chip tone="accent">{kind}</Chip>
        <code>{entry.path}</code>
      </div>
      {document ? (
        <div className="resource-form">
          <Form spec={document.spec ?? {}} updateSpec={updateSpec} context={context} />
        </div>
      ) : (
        <Notice
          tone="error"
          action={
            <button type="button" className="pe-link" onClick={() => onOpenFile(entry.path)}>
              Open {entry.path} in Files
            </button>
          }
        >
          {`${entry.path} is not a JSON document right now, so it has no form. Repair its text in Files.`}
        </Notice>
      )}
    </section>
  );
}

/**
 * The rules and objectives of the package: what the last valid check read (the view the problem page shows, each rule opening
 * where the package writes it), then the forms of its constraint sets and of its optimization, which write the documents. The view
 * follows the next valid check.
 */
export function RulesPane({
  facts,
  stale,
  files,
  update,
  onOpenOrigin,
  onOpenFile,
}: RulesPaneProps) {
  const resources = instanceResources(parseJson(files['instance.json']), files);
  const local = resources.filter((entry): entry is ResourceEntry & { path: string } =>
    Boolean(entry.path)
  );
  // A document of its kind, or one under its role that does not parse right now (its form then sends to Files).
  const ofKind = (kind: string, role: string) =>
    local.filter(entry => entry.kind === kind || (entry.role === role && entry.kind === 'Unknown'));
  const sets = ofKind('ConstraintSet', 'constraintSet');
  const optimizations = ofKind('Optimization', 'optimization');
  return (
    <div className="pe-pane-body">
      {stale && <StaleNote />}
      {facts ? (
        <RulesAndObjectives facts={facts} subject="package" onOpenOrigin={onOpenOrigin} />
      ) : (
        <NotChecked what="The rules and objectives appear" />
      )}
      <section className="pe-rules-edit" aria-labelledby="pe-rules-edit">
        <h2 id="pe-rules-edit">Edit the rules and objectives</h2>
        <p className="pe-muted">
          The forms write the package’s documents; what the check reads from them shows above after
          the next valid check.
        </p>
        {sets.length === 0 && (
          <p className="pe-note">
            The package has no constraint set. Add one to the Instance in Forms to write rules.
          </p>
        )}
        {sets.map(entry => (
          <DocumentForm
            key={entry.path}
            kind="ConstraintSet"
            entry={entry}
            files={files}
            update={update}
            onOpenFile={onOpenFile}
            Form={ConstraintSetForm}
          />
        ))}
        {optimizations.length === 0 && (
          <p className="pe-note">
            The package has no optimization. Add one to the Instance in Forms to write criteria.
          </p>
        )}
        {optimizations.map(entry => (
          <DocumentForm
            key={entry.path}
            kind="Optimization"
            entry={entry}
            files={files}
            update={update}
            onOpenFile={onOpenFile}
            Form={OptimizationForm}
          />
        ))}
      </section>
    </div>
  );
}
