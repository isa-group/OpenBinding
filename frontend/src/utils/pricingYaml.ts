/**
 * A reader and a writer for the part of YAML that Pricing2Yaml documents use: block mappings and sequences, flow
 * `{ a: 1 }` and `[a, b]`, plain and quoted scalars, comments, anchors with aliases and the `<<` merge key.
 *
 * pricing4ts parses a document too, but it clamps every number above 100,000,000 to “unlimited”, which turns a 20 GiB
 * storage limit into no limit at all. The pricing screens need the figures as written, so they read the document here.
 * Anything this reader doesn’t know (block scalars, multi-line flow collections, tags) is an error, never a guess.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

export class YamlError extends Error {}

interface Line {
  indent: number;
  text: string;
  no: number;
}

const isSequenceItem = (text: string) => text === '-' || text.startsWith('- ');

/** Everything before an unquoted ` #`. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (quote === '"' && char === '\\') index += 1;
      else if (char === quote) {
        if (quote === "'" && raw[index + 1] === "'") index += 1;
        else quote = null;
      }
    } else if ((char === '"' || char === "'") && (index === 0 || /[\s:[{,-]/.test(raw[index - 1]))) {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(raw[index - 1]))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function toLines(text: string): Line[] {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const body = stripComment(raw);
    if (body.trim() === '' || /^---\s*$/.test(body)) return;
    if (/^\t/.test(body)) throw new YamlError(`Line ${index + 1}: tabs can’t indent YAML.`);
    lines.push({ indent: body.length - body.trimStart().length, text: body.trim(), no: index + 1 });
  });
  return lines;
}

function plainScalar(text: string): YamlValue {
  if (text === '' || text === '~' || /^null$/i.test(text)) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^\+?\.inf$/i.test(text)) return Number.POSITIVE_INFINITY;
  if (/^-\.inf$/i.test(text)) return Number.NEGATIVE_INFINITY;
  if (/^\.nan$/i.test(text)) return Number.NaN;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  return text;
}

/** A quoted scalar starting at `start`; returns it with the index after the closing quote. */
function quoted(source: string, start: number): [string, number] {
  const mark = source[start];
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (mark === "'") {
      if (char === "'") {
        if (source[index + 1] === "'") { value += "'"; index += 1; } else return [value, index + 1];
      } else value += char;
    } else if (char === '\\') {
      const next = source[index + 1];
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
      if (next === 'u') {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
        index += 5;
      } else {
        value += escapes[next] ?? next;
        index += 1;
      }
    } else if (char === '"') {
      return [value, index + 1];
    } else value += char;
  }
  throw new YamlError('A quoted value is never closed.');
}

/** The key and the rest of a `key: value` line, or `null` when the line isn’t one. */
function splitKeyValue(text: string): { key: string; rest: string } | null {
  if (text[0] === '"' || text[0] === "'") {
    const [key, after] = quoted(text, 0);
    const colon = text.slice(after).match(/^\s*:(\s+|$)/);
    return colon ? { key, rest: text.slice(after + colon[0].length) } : null;
  }
  const match = /^([^\s:#&*[\]{}|>!%@`'"-][^:]*?|-[^\s:][^:]*?|<<)\s*:(\s+|$)/.exec(text);
  return match ? { key: match[1].trim(), rest: text.slice(match[0].length) } : null;
}

class Reader {
  private pos = 0;
  private readonly lines: Line[];
  private readonly anchors = new Map<string, YamlValue>();

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  document(): YamlValue {
    if (this.lines.length === 0) return null;
    const value = this.node(this.lines[0].indent);
    if (this.pos < this.lines.length) throw new YamlError(`Line ${this.lines[this.pos].no}: unexpected content.`);
    return value;
  }

  private node(indent: number): YamlValue {
    const line = this.lines[this.pos];
    return isSequenceItem(line.text) ? this.sequence(line.indent) : this.mapping(indent);
  }

  private mapping(indent: number): YamlMap {
    const result: YamlMap = {};
    const merged: YamlMap[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(`Line ${line.no}: unexpected indentation.`);
      if (isSequenceItem(line.text)) break;
      const pair = splitKeyValue(line.text);
      if (!pair) throw new YamlError(`Line ${line.no}: expected “key: value”.`);
      this.pos += 1;
      const value = this.value(pair.rest, indent, line.no);
      if (pair.key === '<<') {
        for (const source of Array.isArray(value) ? value : [value]) {
          if (typeof source !== 'object' || source === null || Array.isArray(source)) throw new YamlError(`Line ${line.no}: a merge needs a mapping.`);
          merged.push(source);
        }
      } else result[pair.key] = value;
    }
    for (const source of merged) {
      for (const [key, value] of Object.entries(source)) if (!(key in result)) result[key] = value;
    }
    return result;
  }

  private sequence(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.indent !== indent || !isSequenceItem(line.text)) break;
      const rest = line.text.slice(1).trimStart();
      const offset = line.text.length - rest.length;
      if (rest === '') {
        this.pos += 1;
        const next = this.lines[this.pos];
        items.push(next && next.indent > indent ? this.node(next.indent) : null);
      } else if (splitKeyValue(rest) && !/^[{["']/.test(rest)) {
        // `- key: value` opens a mapping whose other keys sit at the column of the first one.
        this.lines[this.pos] = { indent: indent + offset, text: rest, no: line.no };
        items.push(this.mapping(indent + offset));
      } else {
        this.pos += 1;
        items.push(this.value(rest, indent, line.no));
      }
    }
    return items;
  }

  private value(rest: string, parentIndent: number, no: number): YamlValue {
    let text = rest.trim();
    let anchor: string | null = null;
    const anchored = /^&(\S+)\s*(.*)$/.exec(text);
    if (anchored) {
      anchor = anchored[1];
      text = anchored[2];
    }
    let value: YamlValue;
    if (text === '') {
      const next = this.lines[this.pos];
      if (next && next.indent > parentIndent) value = this.node(next.indent);
      else if (next && next.indent === parentIndent && isSequenceItem(next.text)) value = this.sequence(next.indent);
      else value = null;
    } else if (text[0] === '*') {
      value = this.alias(text.slice(1), no);
    } else if (text[0] === '|' || text[0] === '>') {
      throw new YamlError(`Line ${no}: block scalars aren’t supported.`);
    } else if (text[0] === '!') {
      throw new YamlError(`Line ${no}: tags aren’t supported.`);
    } else {
      value = this.inline(text, parentIndent, no);
    }
    if (anchor) this.anchors.set(anchor, value);
    return value;
  }

  private alias(name: string, no: number): YamlValue {
    const found = this.anchors.get(name.trim());
    if (found === undefined) throw new YamlError(`Line ${no}: *${name.trim()} has no anchor.`);
    return structuredClone(found);
  }

  private inline(text: string, parentIndent: number, no: number): YamlValue {
    if (text[0] === '{' || text[0] === '[') {
      const [value, end] = this.flow(text, 0, no);
      if (text.slice(end).trim() !== '') throw new YamlError(`Line ${no}: unexpected text after a flow collection.`);
      return value;
    }
    if (text[0] === '"' || text[0] === "'") {
      const [value, end] = quoted(text, 0);
      if (text.slice(end).trim() !== '') throw new YamlError(`Line ${no}: unexpected text after a quoted value.`);
      return value;
    }
    // A plain scalar may continue on the lines below it, indented deeper than its key.
    let joined = text;
    while (this.pos < this.lines.length && this.lines[this.pos].indent > parentIndent) {
      joined += ` ${this.lines[this.pos].text}`;
      this.pos += 1;
    }
    return plainScalar(joined);
  }

  private flow(source: string, start: number, no: number): [YamlValue, number] {
    let index = start;
    const skip = () => { while (index < source.length && /\s/.test(source[index])) index += 1; };
    const fail = (): never => { throw new YamlError(`Line ${no}: a flow collection isn’t closed or isn’t valid.`); };
    const item = (stops: string): YamlValue => {
      skip();
      const char = source[index];
      if (char === '{' || char === '[') {
        const [value, end] = this.flow(source, index, no);
        index = end;
        return value;
      }
      if (char === '"' || char === "'") {
        const [value, end] = quoted(source, index);
        index = end;
        return value;
      }
      if (char === '*') {
        const name = /^\*([^\s,\]}]+)/.exec(source.slice(index));
        if (!name) return fail();
        index += name[0].length;
        return this.alias(name[1], no);
      }
      let end = index;
      while (end < source.length && !stops.includes(source[end])) end += 1;
      const text = source.slice(index, end).trim();
      index = end;
      return plainScalar(text);
    };

    if (source[index] === '[') {
      index += 1;
      const items: YamlValue[] = [];
      for (;;) {
        skip();
        if (source[index] === ']') { index += 1; break; }
        items.push(item(',]'));
        skip();
        if (source[index] === ',') index += 1;
        else if (source[index] !== ']') return fail();
      }
      return [items, index];
    }
    index += 1;
    const map: YamlMap = {};
    for (;;) {
      skip();
      if (source[index] === '}') { index += 1; break; }
      let key: string;
      if (source[index] === '"' || source[index] === "'") {
        const [text, end] = quoted(source, index);
        key = text;
        index = end;
      } else {
        const colon = source.indexOf(':', index);
        if (colon === -1) return fail();
        key = source.slice(index, colon).trim();
        index = colon;
      }
      skip();
      if (source[index] !== ':') return fail();
      index += 1;
      skip();
      map[key] = source[index] === ',' || source[index] === '}' ? null : item(',}');
      skip();
      if (source[index] === ',') index += 1;
      else if (source[index] !== '}') return fail();
    }
    return [map, index];
  }
}

/** Parse a document. Throws a {@link YamlError} naming the line when it can’t. */
export function parseYaml(text: string): YamlValue {
  return new Reader(toLines(text)).document();
}

// -- Writing -------------------------------------------------------------------------------------------

const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~)$/i;

function scalar(value: string | number | boolean | null, inFlow: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    return Number.isFinite(value) ? String(value) : value > 0 ? '.inf' : '-.inf';
  }
  const plain = /^[A-Za-z_][A-Za-z0-9 _./,()'+%-]*$/.test(value)
    && !RESERVED.test(value) && !/\s$/.test(value) && !value.includes(': ') && !value.includes(' #') && !value.endsWith(':')
    && !(inFlow && /[,[\]{}]/.test(value));
  return plain ? value : JSON.stringify(value);
}

const isScalar = (value: YamlValue): value is string | number | boolean | null => value === null || typeof value !== 'object';
const isMap = (value: YamlValue): value is YamlMap => typeof value === 'object' && value !== null && !Array.isArray(value);
const key = (name: string) => (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) ? name : JSON.stringify(name));

function flow(value: YamlValue): string {
  if (isScalar(value)) return scalar(value, true);
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  const entries = Object.entries(value);
  return entries.length === 0 ? '{}' : `{ ${entries.map(([name, item]) => `${key(name)}: ${flow(item)}`).join(', ')} }`;
}

/** A small mapping of scalars reads best on one line, the way the pricing files write `{ value: 10 }`. */
const compact = (value: YamlMap) => {
  const entries = Object.values(value);
  return entries.length > 0 && entries.length <= 3 && entries.every((item) => isScalar(item) || (Array.isArray(item) && item.every(isScalar)));
};

function block(map: YamlMap, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [name, value] of Object.entries(map)) {
    if (isScalar(value)) out.push(`${pad}${key(name)}: ${scalar(value, false)}`);
    else if (Array.isArray(value)) out.push(`${pad}${key(name)}: ${flow(value)}`);
    else if (Object.keys(value).length === 0) out.push(`${pad}${key(name)}: {}`);
    else if (compact(value)) out.push(`${pad}${key(name)}: ${flow(value)}`);
    else {
      out.push(`${pad}${key(name)}:`);
      out.push(...block(value, indent + 2));
    }
  }
  return out;
}

/** A mapping as block YAML, `indent` spaces in, with no trailing newline. */
export function emitYamlMap(map: YamlMap, indent = 0): string {
  return block(map, indent).join('\n');
}

export { isMap as isYamlMap };

/**
 * Replace the top-level section `name` (`plans:`, `addOns:`) of a document with `body`, keeping everything else as written,
 * comments included. An empty `body` removes the section; a section that isn’t there yet is appended.
 */
export function replaceYamlSection(source: string, name: string, body: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${name}\\s*:`).test(line));
  if (start === -1) {
    if (body.trim() === '') return source;
    return `${source.replace(/\s*$/, '')}\n\n${name}:\n${body}\n`;
  }
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^[\s#]/.test(lines[end]))) end += 1;
  // Blank lines and comments that follow belong to what comes next, not to this section.
  while (end > start + 1 && (lines[end - 1].trim() === '' || /^\s*#/.test(lines[end - 1]) && !/^\s{2,}/.test(lines[end - 1]))) end -= 1;
  const replacement = body.trim() === '' ? [] : [`${name}:`, ...body.split('\n')];
  const rest = lines.slice(end);
  const spaced = replacement.length > 0 && rest.length > 0 && rest[0].trim() !== '' ? [...replacement, ''] : replacement;
  return [...lines.slice(0, start), ...spaced, ...rest].join('\n');
}

/** Replace the value of the top-level `version:` line. */
export function replaceYamlVersion(source: string, version: string): string {
  const pattern = /^version\s*:.*$/m;
  if (!pattern.test(source)) throw new YamlError('The document has no top-level “version:” line.');
  // A semantic version isn’t a number, so it is written as the pricing files write it, unquoted.
  const written = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version) ? version : scalar(version, false);
  return source.replace(pattern, () => `version: ${written}`);
}
