import { parser } from '@lezer/json';

/**
 * Where an RFC 6901 JSON Pointer lands in the text of a JSON document, read on the Lezer JSON syntax tree
 * (`@lezer/json`, the grammar alone): the `[from, to]` of the value it names, in UTF-16 offsets of the text. No second
 * JSON reader and no search for a key's spelling: the pointer is walked member by member and item by item, so a key written
 * twice, a value that repeats elsewhere or a key that needs escaping lands where the gateway meant.
 */

type SyntaxNode = ReturnType<typeof parser.parse>['topNode'];

/** The kinds of node that are a JSON value. */
const VALUES: ReadonlySet<string> = new Set([
  'Object',
  'Array',
  'String',
  'Number',
  'True',
  'False',
  'Null',
]);

/** Where a pointer landed. `exact` is false when the text stops before the pointer does: the range is the deepest value reached. */
export interface PointerTarget {
  from: number;
  to: number;
  exact: boolean;
  /** The kind of value reached (`String`, `Object`, …). */
  kind: string;
}

/** The reference tokens of a pointer, unescaped (`~1` is `/`, `~0` is `~`); `null` for text that is not a pointer. */
export function parsePointer(pointer: string): string[] | null {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return null;
  return pointer
    .slice(1)
    .split('/')
    .map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function children(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) found.push(child);
  return found;
}

const valuesOf = (node: SyntaxNode) => children(node).filter(child => VALUES.has(child.name));

/** The name of a member as JSON reads it (escapes resolved); `null` when its spelling does not parse. */
function memberName(property: SyntaxNode, text: string): string | null {
  const name = property.getChild('PropertyName');
  if (!name) return null;
  try {
    const value: unknown = JSON.parse(text.slice(name.from, name.to));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** The value of the last member of `object` named `name` (JSON readers keep the last of two), or `null`. */
function member(object: SyntaxNode, name: string, text: string): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (const property of children(object)) {
    if (property.name !== 'Property' || memberName(property, text) !== name) continue;
    found = valuesOf(property)[0] ?? null;
  }
  return found;
}

const INDEX = /^(0|[1-9]\d*)$/;

/**
 * The value `pointer` names in `text`, or `null` when the text holds no JSON value at all or the pointer is not one. A pointer
 * the text does not reach to its end lands on the deepest value it does reach, with `exact: false`.
 *
 * One reading is lenient on purpose: a member whose name holds a `/` that the pointer did not escape (`/properties/zone/a` for the
 * member `zone/a`, as the BIM compiler writes some schema findings) is found by joining the tokens that follow.
 */
export function resolvePointer(text: string, pointer: string): PointerTarget | null {
  const tokens = parsePointer(pointer);
  if (!tokens) return null;
  const root = valuesOf(parser.parse(text).topNode)[0];
  if (!root) return null;
  let node = root;
  let index = 0;
  while (index < tokens.length) {
    let next: SyntaxNode | null = null;
    let used = 1;
    if (node.name === 'Object') {
      next = member(node, tokens[index], text);
      for (let end = index + 2; !next && end <= tokens.length; end += 1) {
        next = member(node, tokens.slice(index, end).join('/'), text);
        if (next) used = end - index;
      }
    } else if (node.name === 'Array' && INDEX.test(tokens[index])) {
      next = valuesOf(node)[Number(tokens[index])] ?? null;
    }
    if (!next) return { from: node.from, to: node.to, exact: false, kind: node.name };
    node = next;
    index += used;
  }
  return { from: node.from, to: node.to, exact: true, kind: node.name };
}

/**
 * The text offset of each character (code point) of a JSON string literal's value, plus one past its end: escapes count as the
 * one character they stand for, so a position counted in the value maps back onto the text as written.
 */
function characterOffsets(raw: string, start: number): number[] {
  const offsets: number[] = [];
  let at = 0;
  while (at < raw.length) {
    offsets.push(start + at);
    if (raw[at] === '\\') {
      if (raw[at + 1] === 'u') {
        const unit = parseInt(raw.slice(at + 2, at + 6), 16);
        const pair = unit >= 0xd800 && unit <= 0xdbff && raw.slice(at + 6, at + 8) === '\\u';
        at += pair ? 12 : 6;
      } else {
        at += 2;
      }
    } else {
      at += (raw.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
    }
  }
  offsets.push(start + Math.min(at, raw.length));
  return offsets;
}

/**
 * The expression-span rule. A BIM expression's `span {start, end}` counts characters of the expression string itself (end
 * exclusive), so its place in the text is the start of the string's value (one past the opening quote) plus `start`, read
 * through the escapes the text writes. Answers `null` when `target` is not a string.
 */
export function expressionRange(
  text: string,
  target: Pick<PointerTarget, 'from' | 'to' | 'kind'>,
  span: { start: number; end: number }
): { from: number; to: number } | null {
  if (target.kind !== 'String') return null;
  const closed = target.to - target.from >= 2 && text[target.to - 1] === '"';
  const offsets = characterOffsets(
    text.slice(target.from + 1, closed ? target.to - 1 : target.to),
    target.from + 1
  );
  const at = (position: number) =>
    offsets[Math.max(0, Math.min(offsets.length - 1, Math.trunc(position)))];
  const from = at(span.start);
  return { from, to: Math.max(from, at(span.end)) };
}

/** The one-based line and column of an offset, the column counted in characters (code points), as the panel prints them. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const at = Math.max(0, Math.min(text.length, offset));
  let line = 1;
  let start = 0;
  for (let index = 0; index < at; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      start = index + 1;
    }
  }
  return { line, column: Array.from(text.slice(start, at)).length + 1 };
}
