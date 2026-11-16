import { describe, expect, it } from 'vitest';
import files from '../../test/fixtures/core/refused.package.json';
import refused from '../../test/fixtures/core/refused.validate.json';
import { expressionRange, lineColumn, parsePointer, resolvePointer } from './jsonPointer';

// The refused fixture is the gateway's own answer (dump_frontend_fixtures.py): `refused.package.json` holds the files it checked,
// `refused.validate.json` its 422 body.
const texts = files as Record<string, string>;
const finding = (code: string) => {
  const found = refused.diagnostics.find(item => item.code === code);
  if (!found) throw new Error(`no ${code} in refused.validate.json`);
  return found;
};

const slice = (text: string, pointer: string) => {
  const target = resolvePointer(text, pointer);
  if (!target) throw new Error(`${pointer} did not resolve`);
  return { ...target, text: text.slice(target.from, target.to) };
};

describe('parsePointer', () => {
  it('reads the tokens of a pointer, unescaping ~1 and ~0 in that order', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/')).toEqual(['']);
    expect(parsePointer('/spec/zone~1a/b~0c/~01')).toEqual(['spec', 'zone/a', 'b~c', '~1']);
    expect(parsePointer('spec')).toBeNull();
  });
});

describe('resolvePointer on the refused package', () => {
  it('lands a candidate feature value outside its domain on the value', () => {
    const { pointer, resource } = finding('feature_value_domain');
    const at = slice(texts[resource], pointer);
    expect(at).toMatchObject({ exact: true, kind: 'Number', text: '900' });
  });

  it('lands a pointer through an array onto the object it names', () => {
    const { pointer, resource } = finding('placement_event_pool');
    expect(pointer).toBe('/spec/events/client-request/latency/1/pool');
    const at = slice(texts[resource], pointer);
    expect(at.exact).toBe(true);
    expect(JSON.parse(at.text)).toEqual({ resource: 'placement', id: 'nowhere' });
  });

  it('lands a pointer into an array inside an array on that inner array', () => {
    const { pointer, resource } = finding('placement_capacity_rule');
    const at = slice(texts[resource], pointer);
    expect(at).toMatchObject({ exact: true, kind: 'Array' });
    expect(JSON.parse(at.text)).toEqual(['cpu', 'gpu']);
  });

  it('places the expression span inside the string that holds the expression', () => {
    const { pointer, resource, span } = finding('expression');
    const text = texts[resource];
    const target = resolvePointer(text, pointer);
    expect(target).toMatchObject({ exact: true, kind: 'String' });
    const range = expressionRange(text, target!, span!);
    const expression = JSON.parse(text.slice(target!.from, target!.to)) as string;
    expect(text.slice(range!.from, range!.to)).toBe(expression.slice(span!.start, span!.end));
    expect(range!.from).toBe(target!.from + 1 + span!.start);
  });
});

describe('resolvePointer', () => {
  const text = JSON.stringify(
    {
      spec: { 'zone/a': 1, 'b~c': [[0, [1, 2, 'three']]], twice: 1, other: { twice: 9 } },
      twice: 'first',
      last: true,
    },
    null,
    2
  ).replace('"last": true', '"twice": "second",\n  "last": true');

  it('unescapes ~1 and ~0 in member names', () => {
    expect(slice(text, '/spec/zone~1a').text).toBe('1');
    expect(slice(text, '/spec/b~0c/0/1/2').text).toBe('"three"');
  });

  it('walks arrays inside arrays by index', () => {
    expect(slice(text, '/spec/b~0c/0/1/1')).toMatchObject({ exact: true, text: '2' });
  });

  it('takes the last of two members with the same name, as JSON readers do', () => {
    expect(slice(text, '/twice').text).toBe('"second"');
    expect(slice(text, '/spec/other/twice').text).toBe('9');
  });

  it('finds a member whose name holds a / the pointer did not escape (the compiler writes some schema findings so)', () => {
    expect(slice(text, '/spec/zone/a')).toMatchObject({ exact: true, text: '1' });
  });

  it('lands a pointer the text stops short of on the deepest value it reaches', () => {
    const at = slice(text, '/spec/other/missing/deeper');
    expect(at.exact).toBe(false);
    expect(JSON.parse(at.text)).toEqual({ twice: 9 });
    expect(slice(text, '/spec/b~0c/7').exact).toBe(false);
    expect(slice(text, '/spec/b~0c/01').exact).toBe(false);
  });

  it('answers the whole document for the empty pointer, and nothing for text that holds no value or a pointer that is not one', () => {
    expect(slice(text, '')).toMatchObject({
      from: 0,
      to: text.length,
      exact: true,
      kind: 'Object',
    });
    expect(resolvePointer('', '/a')).toBeNull();
    expect(resolvePointer(text, 'spec')).toBeNull();
  });

  it('reads a document that does not parse as far as it goes', () => {
    expect(slice('{"spec": {"a": 1, "b": ', '/spec/a').text).toBe('1');
  });
});

describe('expressionRange', () => {
  it('counts the characters of the expression, not the escapes the text writes for them', () => {
    const text = '{"assert": "tasks.a.provider.id == \\"x\\" && é😀 <= "}';
    const target = resolvePointer(text, '/assert')!;
    const expression = JSON.parse(text).assert as string;
    const characters = Array.from(expression);
    const start = characters.indexOf('<');
    const range = expressionRange(text, target, { start, end: start + 2 })!;
    expect(text.slice(range.from, range.to)).toBe('<=');
    const quoted = expressionRange(text, target, {
      start: expression.indexOf('"'),
      end: expression.indexOf('"') + 3,
    })!;
    expect(text.slice(quoted.from, quoted.to)).toBe('\\"x\\"');
  });

  it('places nothing in a value that is not a string', () => {
    expect(
      expressionRange('{"a": 1}', resolvePointer('{"a": 1}', '/a')!, { start: 0, end: 1 })
    ).toBeNull();
  });
});

describe('lineColumn', () => {
  it('counts lines and characters from one', () => {
    expect(lineColumn('ab\ncd😀e', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn('ab\ncd😀e', 4)).toEqual({ line: 2, column: 2 });
    expect(lineColumn('ab\ncd😀e', 7)).toEqual({ line: 2, column: 4 });
  });
});
