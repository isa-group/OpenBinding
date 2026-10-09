import { Fragment } from 'react';
import { FileText, Folder } from 'lucide-react';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { shortDigest } from '../../utils/digest';
import { formatBytes } from '../../utils/format';
import type { DiagnosticGroup } from './diagnostics';
import { ROLE_LABELS, type PackageModel, type PackageTreeNode, type WorkflowNode } from './packageModel';

function Workflow({ node }: { node: WorkflowNode }) {
  if (node.type === 'task') {
    return (
      <div className="wb-task">
        <strong>{node.id}</strong>
        <span>{node.capability ?? 'no capability'}</span>
        {node.candidates !== null && <Chip tone="accent">{node.candidates} {node.candidates === 1 ? 'candidate' : 'candidates'}</Chip>}
        {node.note && <small>{node.note}</small>}
      </div>
    );
  }
  const row = node.label === 'SEQUENCE';
  return (
    <div className={`wb-block${row ? ' is-sequence' : ''}`}>
      <span className="wb-block-label">{node.label}{node.note ? ` · ${node.note}` : ''}</span>
      <div className={row ? 'wb-flow' : 'wb-stack'}>
        {node.children.map((child, index) => (
          <Fragment key={index}>
            {row && index > 0 && <span className="wb-arrow" aria-hidden="true">→</span>}
            <Workflow node={child} />
          </Fragment>
        ))}
        {node.children.length === 0 && <span className="wb-muted">empty</span>}
      </div>
    </div>
  );
}

function FileNode({ node, depth, digests, problems, onShowProblems }: {
  node: PackageTreeNode;
  depth: number;
  digests: Record<string, string>;
  problems: Record<string, number>;
  onShowProblems: (path: string) => void;
}) {
  const file = node.file;
  const count = problems[node.path] ?? 0;
  return (
    <>
      <li style={{ paddingInlineStart: `${depth * 20}px` }} id={file ? `wb-file-${node.path}` : undefined} tabIndex={file ? -1 : undefined} className={count > 0 ? 'has-problems' : undefined}>
        {file ? <FileText aria-hidden="true" /> : <Folder aria-hidden="true" />}
        <span className="wb-file-name">{node.name}</span>
        {file?.role && <Chip tone="accent">{ROLE_LABELS[file.role] ?? file.role}</Chip>}
        {file?.kind && file.kind !== ROLE_LABELS[file.role ?? ''] && <Chip>{file.kind}</Chip>}
        {file && <small>{formatBytes(file.bytes)?.split(' (')[0]}</small>}
        {file && digests[node.path] && <code title={digests[node.path]}>{shortDigest(digests[node.path])}</code>}
        {count > 0 && (
          <button type="button" onClick={() => onShowProblems(node.path)}>{count} {count === 1 ? 'problem' : 'problems'}</button>
        )}
      </li>
      {node.children.map((child) => (
        <FileNode key={child.path} node={child} depth={depth + 1} digests={digests} problems={problems} onShowProblems={onShowProblems} />
      ))}
    </>
  );
}

interface StructureProps {
  model: PackageModel;
  valid: boolean;
  fileDigests: Record<string, string>;
  problemsByFile: Record<string, number>;
  onShowProblems: (path: string) => void;
}

/** The package as a person reads it: its files and roles, the workflow, the choices per task, the rules and the objective. */
export function StructurePanel({ model, valid, fileDigests, problemsByFile, onShowProblems }: StructureProps) {
  const weightTotal = model.criteria.reduce((sum, criterion) => sum + (criterion.weight ?? 0), 0);
  return (
    <div className="wb-structure">
      {!valid && <p className="wb-muted">Read from your files. The package did not validate, so treat this as a sketch and fix the diagnostics first.</p>}

      {model.workflow && (
        <section aria-label="Workflow" className="wb-card">
          <div className="wb-card-title"><span>Workflow</span><small>profile {model.profile ?? 'not stated'}</small></div>
          <div className="wb-scroll"><Workflow node={model.workflow} /></div>
          <div className="wb-legend">
            <span><i className="wb-swatch" />Service task (bound to a candidate)</span>
            {model.bindingSpaceLog10 !== null && <span>Binding space ≈ 10<sup>{model.bindingSpaceLog10.toFixed(1)}</sup> combinations (upper bound)</span>}
          </div>
        </section>
      )}

      <section aria-label="Package files" className="wb-card">
        <div className="wb-card-title"><span>Package files</span><small>{model.files.length} {model.files.length === 1 ? 'file' : 'files'}{model.name ? ` · ${model.name}` : ''}</small></div>
        <ul className="wb-files">
          {model.tree.map((node) => (
            <FileNode key={node.path} node={node} depth={0} digests={fileDigests} problems={problemsByFile} onShowProblems={onShowProblems} />
          ))}
        </ul>
        {model.registered.length > 0 && (
          <div className="wb-registered">
            <span>Registered resources it points to</span>
            {model.registered.map((use) => <Chip key={`${use.role}/${use.logicalId}`} mono>{use.reference} · {ROLE_LABELS[use.role] ?? use.role}</Chip>)}
          </div>
        )}
      </section>

      {model.tasks.length > 0 && (
        <section aria-label="Tasks">
          <DataTable label="Choices per task" minWidth={520}>
            <thead><tr><th scope="col">Task</th><th scope="col">Capability</th><th scope="col">Candidates</th><th scope="col">Range per feature</th></tr></thead>
            <tbody>
              {model.tasks.map((task) => (
                <tr key={task.id}>
                  <td className="is-mono">{task.id}</td>
                  <td>{task.capability ?? '—'}</td>
                  <td>{task.candidates}</td>
                  <td>{task.ranges.length ? task.ranges.map((range) => `${range.feature} ${range.min}–${range.max}${range.unit ? ` ${range.unit}` : ''}`).join(' · ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      )}

      {(model.constraints.length > 0 || model.criteria.length > 0) && (
        <div className="wb-pair">
          {model.constraints.length > 0 && (
            <section aria-label="Constraints" className="wb-card">
              <div className="wb-card-title"><span>Constraints</span><small>{model.constraints.length}</small></div>
              <ul className="wb-rules">
                {model.constraints.map((constraint) => (
                  <li key={constraint.id}>
                    {constraint.enforcement && <span className={`wb-tag is-${constraint.enforcement}`}>{constraint.enforcement.toUpperCase()}</span>}
                    <span>{constraint.text ?? <code>{constraint.id}</code>}{constraint.penalty !== null ? ` · penalty ${constraint.penalty}` : ''}</span>
                    {constraint.text && <code>{constraint.id}</code>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {model.criteria.length > 0 && (
            <section aria-label="Objective" className="wb-card">
              <div className="wb-card-title"><span>Objective{model.optimizationMode ? ` · ${model.optimizationMode}` : ''}</span><small>{model.criteria.length}</small></div>
              <ul className="wb-criteria">
                {model.criteria.map((criterion) => (
                  <li key={criterion.id}>
                    <span>{criterion.id}</span>
                    {criterion.weight !== null && weightTotal > 0
                      ? <span className="wb-bar" role="img" aria-label={`weight ${criterion.weight}`}><i style={{ width: `${Math.round((criterion.weight / weightTotal) * 100)}%` }} /></span>
                      : <span />}
                    <small>{[criterion.weight !== null ? criterion.weight : null, criterion.direction].filter((part) => part !== null).join(' · ') || '—'}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

interface DiagnosticsProps {
  valid: boolean;
  groups: DiagnosticGroup[];
  /** The gateway's own sentence, when it refused the package without itemising why. */
  summary: string | null;
  onShowFile: (path: string) => void;
  copy: (value: string, key: string) => void;
  copied: (key: string) => boolean;
}

/** Problems grouped by file, each with where it is in words, the gateway's message, and a way to jump to the file. */
export function DiagnosticsPanel({ valid, groups, summary, onShowFile, copy, copied }: DiagnosticsProps) {
  if (valid && groups.length === 0) {
    return <div className="wb-ok">No diagnostics. Every resource passed validation.</div>;
  }
  return (
    <div className="wb-diagnostics">
      {summary && <p className="wb-summary">{summary}</p>}
      {groups.map((group) => (
        <section key={group.file || 'package'} className="wb-group" aria-label={`Problems in ${group.label}`}>
          <header id={`wb-problems-${group.file || 'package'}`} tabIndex={-1}>
            <span className="wb-group-label">{group.label}</span>
            <small>{group.items.length} {group.items.length === 1 ? 'problem' : 'problems'}</small>
            {group.file && <button type="button" onClick={() => onShowFile(group.file)}>Show in package</button>}
          </header>
          <ul>
            {group.items.map((item, index) => {
              const key = `${group.file}:${index}`;
              return (
                <li key={key}>
                  <div className="wb-diag-top">
                    <span className="wb-tag is-error">ERROR</span>
                    {item.code && <code>{item.code}</code>}
                    <span className="wb-where">{item.where}</span>
                    {item.location && (
                      <button type="button" onClick={() => copy(`${group.file ? `${group.file} ` : ''}${item.location}`, key)}>
                        {copied(key) ? 'Copied' : 'Copy location'}
                      </button>
                    )}
                  </div>
                  <p>{item.message}</p>
                  {item.fix && <p className="wb-fix"><strong>Fix:</strong> {item.fix}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
