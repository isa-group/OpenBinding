import { useId } from 'react';
import {
  blockLabel,
  loopTimes,
  type TaskOverlay,
  type WNode,
  type WorkflowGraph as Graph,
} from '../../entities/binding/workflowGraph';
import './WorkflowGraph.css';

interface WorkflowGraphProps {
  graph: Graph;
  /** What the screen says about each task, by task id. */
  overlay?: Record<string, TaskOverlay>;
  /** `auto` runs left to right from 640 px and stacks below; `vertical` always stacks. */
  orientation?: 'auto' | 'vertical';
  /** The accessible name of the drawing. */
  label: string;
  /** Makes each task a button. */
  onSelectTask?: (task: string) => void;
}

const STATUS_TEXT: Record<NonNullable<TaskOverlay['status']>, string> = {
  selected: 'selected',
  added: 'added',
  removed: 'removed',
  changed: 'changed',
};

function Task({
  id,
  overlay,
  probability,
  onSelect,
}: {
  id: string;
  overlay: TaskOverlay | undefined;
  probability?: number | null;
  onSelect?: (task: string) => void;
}) {
  const local = overlay?.local === true;
  const body = (
    <>
      <span className="wg-task-top">
        <code>{id}</code>
        {probability !== undefined && probability !== null && <b>{probability}</b>}
      </span>
      {probability !== undefined && probability !== null && (
        <span className="wg-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(Math.min(1, Math.max(0, probability)) * 100)}%` }} />
        </span>
      )}
      {local ? (
        <small>local task · not bound</small>
      ) : overlay?.candidate ? (
        <small>
          candidate <code>{overlay.candidate}</code>
        </small>
      ) : null}
      {overlay?.status && (
        <span className={`wg-status is-${overlay.status}`}>{STATUS_TEXT[overlay.status]}</span>
      )}
    </>
  );
  const className = `wg-task${local ? ' is-local' : ''}${overlay?.status ? ` is-${overlay.status}` : ''}`;
  return onSelect ? (
    <button type="button" className={className} onClick={() => onSelect(id)}>
      {body}
    </button>
  ) : (
    <span className={className}>{body}</span>
  );
}

function Step({
  node,
  overlay,
  onSelect,
  probability,
}: {
  node: WNode;
  overlay: Record<string, TaskOverlay>;
  onSelect?: (task: string) => void;
  probability?: number | null;
}) {
  switch (node.kind) {
    case 'task':
      return (
        <Task
          id={node.id}
          overlay={overlay[node.id]}
          probability={probability}
          onSelect={onSelect}
        />
      );
    case 'empty':
      return (
        <span className="wg-empty">
          nothing happens
          {probability !== undefined && probability !== null ? ` · ${probability}` : ''}
        </span>
      );
    case 'unreadable':
      return (
        <span className="wg-unreadable" role="note">
          This step can’t be drawn: {node.reason}.
        </span>
      );
    case 'seq':
      return (
        <ol className="wg-seq" aria-label={blockLabel(node)}>
          {node.children.map((child, index) => (
            <li key={index}>
              <Step node={child} overlay={overlay} onSelect={onSelect} />
              {index < node.children.length - 1 && <span className="wg-arrow" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      );
    case 'and':
      return (
        <div className="wg-block" role="group" aria-label={blockLabel(node)}>
          <span className="wg-block-label" aria-hidden="true">
            Parallel · all at once
          </span>
          <ul>
            {node.children.map((child, index) => (
              <li key={index}>
                <Step node={child} overlay={overlay} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'xor': {
      const stated = node.branches.some(branch => branch.probability !== null);
      return (
        <div className="wg-block" role="group" aria-label={blockLabel(node)}>
          <span className="wg-block-label" aria-hidden="true">
            {node.uniform ? 'One of · equal' : stated ? 'One of · by probability' : 'One of'}
          </span>
          <ul>
            {node.branches.map((branch, index) => (
              <li key={index}>
                {branch.node.kind === 'task' || branch.node.kind === 'empty' ? (
                  <Step
                    node={branch.node}
                    overlay={overlay}
                    onSelect={onSelect}
                    probability={branch.probability}
                  />
                ) : (
                  <>
                    {branch.probability !== null && (
                      <b className="wg-branch-p">{branch.probability}</b>
                    )}
                    <Step node={branch.node} overlay={overlay} onSelect={onSelect} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case 'loop':
      return (
        <div className="wg-block" role="group" aria-label={blockLabel(node)}>
          <span className="wg-block-label" aria-hidden="true">
            Repeat · {loopTimes(node)}
          </span>
          <Step node={node.body} overlay={overlay} onSelect={onSelect} />
        </div>
      );
    default:
      return null;
  }
}

/** A workflow drawn as nested lists: what runs in sequence, in parallel, as alternatives or repeated, with each task in words. */
export function WorkflowGraph({
  graph,
  overlay = {},
  orientation = 'auto',
  label,
  onSelectTask,
}: WorkflowGraphProps) {
  const describedBy = useId();
  const local = Object.values(overlay).some(entry => entry.local);
  return (
    <figure
      className={`wg${orientation === 'vertical' ? ' is-vertical' : ''}`}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
    >
      <p id={describedBy} className="sr-only">
        {graph.description}
      </p>
      <div className="wg-scroll">
        <div className="wg-canvas">
          <Step node={graph.root} overlay={overlay} onSelect={onSelectTask} />
        </div>
      </div>
      <figcaption className="wg-legend">
        <span>
          <i className="wg-key" />
          Service task (gets a candidate)
        </span>
        {local && (
          <span>
            <i className="wg-key is-local" />
            Local task
          </span>
        )}
      </figcaption>
    </figure>
  );
}
