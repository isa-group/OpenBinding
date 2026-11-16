/**
 * The workflow graph view-model: one shape for every workflow drawn on screen. Its input is a workflow node in the
 * Composition2Yaml JSON shape (docs/COMPOSITION2YAML.md §4), which is both a document's `workflow` and a problem's
 * `facts.workflow`: the gateway writes both with the same function, so a problem and a composition derived from it give
 * the same graph. Nothing here normalises beyond flattening a nested `seq`, and an unknown shape is kept as `unreadable`
 * so the screen says so instead of dropping it.
 */

export type WNode =
  | { kind: 'task'; id: string }
  | { kind: 'seq'; children: WNode[] }
  | { kind: 'and'; children: WNode[] }
  | { kind: 'xor'; branches: { probability: number | null; node: WNode }[]; uniform: boolean }
  | { kind: 'loop'; body: WNode; count: number | null; expected: number | null }
  | { kind: 'empty' }
  | { kind: 'unreadable'; reason: string };

export interface WorkflowGraph {
  root: WNode;
  /** Each task once, in the order a depth-first walk meets it. */
  tasks: string[];
  /** The workflow in words, for the accessible description of its drawing. */
  description: string;
}

/** What a screen says about a task on top of the graph: its candidate, whether it is local, and how it changed. */
export type TaskOverlay = {
  candidate?: string;
  local?: boolean;
  status?: 'selected' | 'added' | 'removed' | 'changed';
};

const MAX_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Does the object have only these keys, and the first of them? */
const shaped = (node: Record<string, unknown>, head: string, allowed: readonly string[]) =>
  Object.hasOwn(node, head) && Object.keys(node).every(key => allowed.includes(key));

const unreadable = (reason: string): WNode => ({ kind: 'unreadable', reason });

function read(node: unknown, depth: number): WNode {
  if (depth > MAX_DEPTH) return unreadable('nested deeper than this page draws');
  if (node === null) return { kind: 'empty' };
  if (node === undefined) return unreadable('a missing step');
  if (typeof node === 'string')
    return node ? { kind: 'task', id: node } : unreadable('a task without an id');
  if (!isRecord(node))
    return unreadable(`a ${Array.isArray(node) ? 'list' : typeof node} where a step was expected`);

  if (shaped(node, 'seq', ['seq']) && Array.isArray(node.seq)) {
    // The gateway already normalises; a nested sequence is flattened defensively, as it reads the same.
    const children = node.seq.flatMap(child => {
      const step = read(child, depth + 1);
      return step.kind === 'seq' ? step.children : [step];
    });
    return { kind: 'seq', children };
  }
  if (shaped(node, 'and', ['and']) && Array.isArray(node.and)) {
    return { kind: 'and', children: node.and.map(child => read(child, depth + 1)) };
  }
  if (shaped(node, 'xor', ['xor', 'uniform']) && Array.isArray(node.xor)) {
    const branches = node.xor.map(branch =>
      isRecord(branch) && shaped(branch, 'flow', ['flow', 'probability'])
        ? { probability: finite(branch.probability), node: read(branch.flow, depth + 1) }
        : { probability: null, node: read(branch, depth + 1) }
    );
    return { kind: 'xor', branches, uniform: node.uniform === true };
  }
  if (shaped(node, 'loop', ['loop', 'count', 'expected'])) {
    return {
      kind: 'loop',
      body: read(node.loop, depth + 1),
      count: finite(node.count),
      expected: finite(node.expected),
    };
  }
  const keys = Object.keys(node);
  return unreadable(keys.length ? `an unknown step with ${keys.join(', ')}` : 'an empty object');
}

function tasksOf(root: WNode): string[] {
  const found: string[] = [];
  const walk = (node: WNode) => {
    switch (node.kind) {
      case 'task':
        if (!found.includes(node.id)) found.push(node.id);
        break;
      case 'seq':
      case 'and':
        node.children.forEach(walk);
        break;
      case 'xor':
        node.branches.forEach(branch => walk(branch.node));
        break;
      case 'loop':
        walk(node.body);
        break;
      default:
        break;
    }
  };
  walk(root);
  return found;
}

const branches = (count: number) => (count === 1 ? '1 branch' : `${count} branches`);

/** How many times a loop runs, in words: `2 times`, `about 2.5 times`, or `repeated` when the loop says neither. */
export function loopTimes(node: Extract<WNode, { kind: 'loop' }>): string {
  if (node.count !== null) return node.count === 1 ? '1 time' : `${node.count} times`;
  if (node.expected !== null) return `about ${node.expected} times`;
  return 'a number of times not stated';
}

/** The accessible name of a block: `Parallel, 2 branches`, `Choice, 3 branches, probabilities 0.5, 0.3, 0.2`, `Repeat, expected 2.5 times`. */
export function blockLabel(node: WNode): string {
  switch (node.kind) {
    case 'seq':
      return `Sequence, ${node.children.length === 1 ? '1 step' : `${node.children.length} steps`}`;
    case 'and':
      return `Parallel, ${branches(node.children.length)}`;
    case 'xor': {
      const head = `Choice, ${branches(node.branches.length)}`;
      if (node.uniform) return `${head}, equally likely`;
      const stated = node.branches.map(branch => branch.probability);
      return stated.every(probability => probability !== null) && stated.length > 0
        ? `${head}, probabilities ${stated.join(', ')}`
        : head;
    }
    case 'loop':
      if (node.count !== null)
        return `Repeat, ${node.count === 1 ? '1 time' : `${node.count} times`}`;
      if (node.expected !== null) return `Repeat, expected ${node.expected} times`;
      return 'Repeat';
    case 'task':
      return `Task ${node.id}`;
    case 'empty':
      return 'Nothing happens';
    case 'unreadable':
      return 'A step that can’t be read';
    default:
      return '';
  }
}

function say(node: WNode): string {
  const part = (child: WNode) => {
    const text = say(child);
    return (child.kind === 'seq' || child.kind === 'and' || child.kind === 'xor') &&
      text.includes(' ')
      ? `(${text})`
      : text;
  };
  switch (node.kind) {
    case 'task':
      return node.id;
    case 'empty':
      return 'nothing';
    case 'seq':
      return node.children.length ? node.children.map(part).join(', then ') : 'nothing';
    case 'and':
      return `${node.children.map(part).join(' and ')} in parallel`;
    case 'xor': {
      const options = node.branches.map(
        branch =>
          `${part(branch.node)}${branch.probability !== null ? ` (probability ${branch.probability})` : ''}`
      );
      return `one of ${options.join(' or ')}${node.uniform ? ', equally likely' : ''}`;
    }
    case 'loop':
      return `${part(node.body)} repeated ${loopTimes(node)}`;
    case 'unreadable':
      return `a step that can’t be read (${node.reason})`;
    default:
      return '';
  }
}

/** The graph of a Composition2Yaml workflow node: `document.workflow` of a version, or `facts.workflow` of a problem. */
export function workflowGraph(node: unknown): WorkflowGraph {
  const root = read(node, 0);
  return { root, tasks: tasksOf(root), description: `Workflow: ${say(root)}` };
}
