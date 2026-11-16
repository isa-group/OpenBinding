import { yamlLanguage } from '@codemirror/lang-yaml';

/**
 * Where things are in the text of a Composition2Yaml document, read from the Lezer YAML tree of the code editor. Only places are
 * read here (the key path at the cursor, the range of a scalar): what a document means, and whether it is valid, is always the
 * gateway's answer. Nothing here reads the document into a model.
 */

type Tree = ReturnType<typeof yamlLanguage.parser.parse>;
type Node = Tree['topNode'];

/** A step of a key path: a mapping key, or `[]` for an item of a sequence. */
export const ITEM = '[]';

const parse = (text: string): Tree => yamlLanguage.parser.parse(text);

/** A scalar as YAML reads it: quotes removed (escapes inside a double-quoted scalar are left as written). */
function unquote(raw: string): string {
  const text = raw.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

const keyOf = (pair: Node, text: string): string | null => {
  const key = pair.getChild('Key');
  return key ? unquote(text.slice(key.from, key.to)) : null;
};

/** The value node of a pair: whatever follows its `:`. */
function valueOf(pair: Node): Node | null {
  let colon = false;
  for (let child = pair.firstChild; child; child = child.nextSibling) {
    if (child.name === ':') colon = true;
    else if (colon && child.name !== 'Comment') return child;
  }
  return null;
}

/** The mapping that holds the document's top-level keys. */
function rootMapping(tree: Tree): Node | null {
  const document = tree.topNode.getChild('Document');
  return document?.getChild('BlockMapping') ?? document?.getChild('FlowMapping') ?? null;
}

/** The pair of a mapping with this key. */
const pairIn = (mapping: Node, key: string, text: string): Node | null =>
  mapping.getChildren('Pair').find(pair => keyOf(pair, text) === key) ?? null;

/** The key path of a node: the keys of the pairs around it, outermost first, with `[]` for each sequence item. */
function pathOf(node: Node | null, text: string): string[] {
  const path: string[] = [];
  for (let at = node; at; at = at.parent) {
    if (at.name === 'Pair') {
      const key = keyOf(at, text);
      if (key !== null) path.unshift(key);
    } else if (at.name === 'Item') {
      path.unshift(ITEM);
    }
  }
  return path;
}

export interface ScalarPlace {
  from: number;
  to: number;
  /** The scalar as YAML reads it. */
  value: string;
}

/** The range and text of the scalar at a key path of block or flow mappings (`['problem', 'ref']`), or null. */
export function scalarAt(text: string, path: readonly string[]): ScalarPlace | null {
  let mapping = rootMapping(parse(text));
  for (let index = 0; mapping && index < path.length; index += 1) {
    const pair = pairIn(mapping, path[index], text);
    const value = pair ? valueOf(pair) : null;
    if (!value) return null;
    if (index === path.length - 1) {
      return value.name === 'Literal' || value.name === 'QuotedLiteral'
        ? { from: value.from, to: value.to, value: unquote(text.slice(value.from, value.to)) }
        : null;
    }
    mapping = value.name === 'BlockMapping' || value.name === 'FlowMapping' ? value : null;
  }
  return null;
}

/**
 * The text with the top-level scalar `key` written as `value`, everything else (comments, order, style) kept. A document without
 * the key gets it on a first line of its own. The value is written as given: whether it reads as the gateway expects is the
 * gateway's to say.
 */
export function withTopLevelScalar(text: string, key: string, value: string): string {
  const place = scalarAt(text, [key]);
  if (place) return text.slice(0, place.from) + value + text.slice(place.to);
  return `${key}: ${value}\n${text}`;
}

export interface CursorPlace {
  /** The key path of the mapping (or sequence) the cursor writes into. */
  path: string[];
  /** Writing a key of that mapping, or the value of `key`. */
  at: 'key' | 'value';
  /** The key whose value is being written. */
  key?: string;
  /** Where the word being written starts. */
  from: number;
  /** The word written so far. */
  word: string;
}

/** The column of an offset in its line. */
const columnOf = (text: string, offset: number) =>
  offset - (text.lastIndexOf('\n', offset - 1) + 1);

/**
 * The key path of the block mapping a line at `column` belongs to: the last pair of a block mapping that starts on an earlier
 * line, further left, holds it.
 */
function blockParent(tree: Tree, text: string, lineStart: number, column: number): string[] {
  let parent: Node | null = null;
  tree.iterate({
    enter(ref) {
      if (ref.from >= lineStart) return false;
      if (ref.name !== 'Pair' || ref.node.parent?.name !== 'BlockMapping') return undefined;
      if (columnOf(text, ref.from) < column) parent = ref.node;
      return undefined;
    },
  });
  return parent ? pathOf(parent, text) : [];
}

const WORD = /[^\s:,{}[\]#"']*$/;

/**
 * Inside the flow collections opened on this line (`notify: {candidate: x, from: {sph`): the keys of the open mappings (or `[]`
 * for an open sequence) and what is being written in the innermost one, or null when every collection is closed.
 */
function openFlow(rest: string): { keys: string[]; segment: string } | null {
  const stack: Array<{ key: string; start: number }> = [];
  let quote: string | null = null;
  let segmentStart = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') {
      const before = rest.slice(segmentStart, index);
      const named = /([^\s:,{}[\]]+)\s*:\s*$/.exec(before);
      stack.push({ key: char === '[' ? ITEM : named ? unquote(named[1]) : ITEM, start: index + 1 });
      segmentStart = index + 1;
    } else if (char === '}' || char === ']') {
      stack.pop();
      segmentStart = index + 1;
    } else if (char === ',') {
      segmentStart = index + 1;
    }
  }
  if (!stack.length) return null;
  // The first collection is the value of the line's own key, which the caller has already put in the path.
  return { keys: stack.slice(1).map(open => open.key), segment: rest.slice(segmentStart) };
}

/**
 * Where the cursor writes: the key path, and whether it writes a key or a value (with the key). Block style is read by
 * indentation over the tree's pairs; a flow collection opened on the cursor's line is read on that line.
 */
export function cursorPlace(text: string, pos: number): CursorPlace {
  const tree = parse(text);
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const word = WORD.exec(before)?.[0] ?? '';
  const from = pos - word.length;
  const lead = /^(\s*)((?:-\s+)*)/.exec(before) ?? ['', '', ''];
  const column = lead[1].length + lead[2].length;
  const rest = before.slice(column);
  const parent = blockParent(tree, text, lineStart, column);
  const pair = /^([^\s:{}[\],#][^:{}[\],#]*?)\s*:(?:\s+|$)(.*)$/.exec(rest);
  if (!pair) return { path: parent, at: 'key', from, word };

  const key = unquote(pair[1]);
  const flow = openFlow(pair[2]);
  if (!flow) return { path: [...parent, key], at: 'value', key, from, word };
  const path = [...parent, key, ...flow.keys];
  const inner = /^\s*([^\s:,{}[\]]+)\s*:\s*(.*)$/.exec(flow.segment);
  if (path[path.length - 1] === ITEM && !inner) return { path, at: 'value', from, word };
  return inner
    ? { path: [...path, unquote(inner[1])], at: 'value', key: unquote(inner[1]), from, word }
    : { path, at: 'key', from, word };
}
