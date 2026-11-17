import { useId } from 'react';
import {
  blockLabel,
  loopTimes,
  type TaskOverlay,
  type WNode,
  type WorkflowGraph as Graph,
} from '../../utils/binding/workflowGraph';

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

/** The border of a task by what the screen says about it. */
const TASK_BORDER: Record<NonNullable<TaskOverlay['status']> | 'plain' | 'local', string> = {
  plain: 'border-tp-primary',
  selected: 'border-tp-primary',
  local: 'border-dashed border-tp-hairline-strong',
  added: 'border-tp-diff-added',
  removed: 'border-dotted border-tp-diff-removed',
  changed: 'border-tp-diff-changed',
};

/**
 * How a sequence lies: `row` left to right from 640 px (stacked below), `column` always stacked (inside a block, or a vertical
 * drawing).
 */
type Flow = 'row' | 'column';

function Arrow({ flow }: { flow: Flow }) {
  return flow === 'column' ? (
    <span className="flex-none text-center text-tp-steel" aria-hidden="true">
      ↓
    </span>
  ) : (
    <span className="flex-none text-center text-tp-steel" aria-hidden="true">
      <span className="sm:hidden">↓</span>
      <span className="hidden sm:inline">→</span>
    </span>
  );
}

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
      <span className="flex justify-between gap-1.5">
        <code className="font-mono text-xs font-medium [overflow-wrap:anywhere]">{id}</code>
        {probability !== undefined && probability !== null && (
          <b className="text-[11px] font-semibold">{probability}</b>
        )}
      </span>
      {probability !== undefined && probability !== null && (
        <span
          className="block h-1 overflow-hidden rounded-full bg-tp-hairline-soft"
          aria-hidden="true"
        >
          <i
            className="block h-full bg-tp-primary"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, probability)) * 100)}%` }}
          />
        </span>
      )}
      {local ? (
        <small className="text-[11px] text-tp-steel">local task · not bound</small>
      ) : overlay?.candidate ? (
        <small className="text-[11px] text-tp-steel">
          candidate <code className="font-mono">{overlay.candidate}</code>
        </small>
      ) : null}
      {overlay?.status && (
        <span
          data-wg-status={overlay.status}
          className="self-start rounded bg-tp-cream-deeper px-1.5 py-px text-[11px] font-semibold"
        >
          {STATUS_TEXT[overlay.status]}
        </span>
      )}
    </>
  );
  const border = TASK_BORDER[overlay?.status ?? (local ? 'local' : 'plain')];
  const className = `flex min-w-0 flex-none flex-col gap-1 rounded-xl border-2 bg-tp-canvas p-2.5 text-left text-tp-ink sm:min-w-[130px] ${border}`;
  const marks = { 'data-wg-task': id, 'data-status': overlay?.status } as const;
  return onSelect ? (
    <button
      type="button"
      {...marks}
      className={`${className} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tp-primary-deep`}
      onClick={() => onSelect(id)}
    >
      {body}
    </button>
  ) : (
    <span {...marks} className={className}>
      {body}
    </span>
  );
}

const BLOCK =
  'flex min-w-0 flex-none flex-col gap-1.5 rounded-xl border border-tp-severity-info-border bg-tp-surface-cream p-2 sm:min-w-[170px]';
const BLOCK_LABEL = 'text-[10px] font-semibold tracking-[0.16em] text-tp-primary-deep uppercase';

function Step({
  node,
  overlay,
  onSelect,
  probability,
  flow,
}: {
  node: WNode;
  overlay: Record<string, TaskOverlay>;
  onSelect?: (task: string) => void;
  probability?: number | null;
  flow: Flow;
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
        <span className="text-xs text-tp-steel">
          nothing happens
          {probability !== undefined && probability !== null ? ` · ${probability}` : ''}
        </span>
      );
    case 'unreadable':
      return (
        <span
          className="rounded-md border border-dashed border-tp-severity-warning-border bg-tp-severity-warning-bg px-2 py-1.5 text-xs"
          role="note"
        >
          This step can’t be drawn: {node.reason}.
        </span>
      );
    case 'seq': {
      const lie =
        flow === 'column'
          ? 'flex-col items-stretch'
          : 'flex-col items-stretch sm:flex-row sm:items-center';
      return (
        <ol className={`flex gap-2 ${lie}`} aria-label={blockLabel(node)}>
          {node.children.map((child, index) => (
            <li key={index} className={`flex gap-2 ${lie}`}>
              <Step node={child} overlay={overlay} onSelect={onSelect} flow={flow} />
              {index < node.children.length - 1 && <Arrow flow={flow} />}
            </li>
          ))}
        </ol>
      );
    }
    case 'and':
      return (
        <div className={BLOCK} role="group" aria-label={blockLabel(node)}>
          <span className={BLOCK_LABEL} aria-hidden="true">
            Parallel · all at once
          </span>
          <ul className="flex flex-col gap-1.5">
            {node.children.map((child, index) => (
              <li key={index} className="flex flex-col gap-1">
                <Step node={child} overlay={overlay} onSelect={onSelect} flow="column" />
              </li>
            ))}
          </ul>
        </div>
      );
    case 'xor': {
      const stated = node.branches.some(branch => branch.probability !== null);
      return (
        <div className={BLOCK} role="group" aria-label={blockLabel(node)}>
          <span className={BLOCK_LABEL} aria-hidden="true">
            {node.uniform ? 'One of · equal' : stated ? 'One of · by probability' : 'One of'}
          </span>
          <ul className="flex flex-col gap-1.5">
            {node.branches.map((branch, index) => (
              <li key={index} className="flex flex-col gap-1">
                {branch.node.kind === 'task' || branch.node.kind === 'empty' ? (
                  <Step
                    node={branch.node}
                    overlay={overlay}
                    onSelect={onSelect}
                    probability={branch.probability}
                    flow="column"
                  />
                ) : (
                  <>
                    {branch.probability !== null && (
                      <b className="text-[11px] font-semibold">{branch.probability}</b>
                    )}
                    <Step node={branch.node} overlay={overlay} onSelect={onSelect} flow="column" />
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
        <div className={BLOCK} role="group" aria-label={blockLabel(node)}>
          <span className={BLOCK_LABEL} aria-hidden="true">
            Repeat · {loopTimes(node)}
          </span>
          <Step node={node.body} overlay={overlay} onSelect={onSelect} flow="column" />
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
      className="m-0 flex min-w-0 flex-col gap-3"
      data-orientation={orientation}
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
    >
      <p id={describedBy} className="sr-only">
        {graph.description}
      </p>
      <div className="overflow-x-auto pb-1">
        <div className="inline-block min-w-full">
          <Step
            node={graph.root}
            overlay={overlay}
            onSelect={onSelectTask}
            flow={orientation === 'vertical' ? 'column' : 'row'}
          />
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-3 text-xs text-tp-slate">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-3.5 rounded-[3px] border-2 border-tp-primary" />
          Service task (gets a candidate)
        </span>
        {local && (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-3.5 rounded-[3px] border-2 border-dashed border-tp-hairline-strong" />
            Local task
          </span>
        )}
      </figcaption>
    </figure>
  );
}
