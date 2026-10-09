import { describe, expect, it } from 'vitest';
import { emitYamlMap, parseYaml, replaceYamlSection, replaceYamlVersion, YamlError, type YamlMap } from './pricingYaml';

describe('pricingYaml · reading', () => {
  it('reads mappings, flow collections, scalars and comments', () => {
    const document = parseYaml([
      '# a comment',
      'name: demo # trailing comment',
      'list: [a, b, 3]',
      "map: { x: 1, y: 'two', z: .inf }",
      'nested:',
      '  deep:',
      '    flag: true',
      '  none:',
      'text: "quoted: yes # not a comment"',
      "expression: pricing['features']['solve'] && ready",
      'version: 0.1.0',
      'price: 0.0',
    ].join('\n'));
    expect(document).toEqual({
      name: 'demo',
      list: ['a', 'b', 3],
      map: { x: 1, y: 'two', z: Number.POSITIVE_INFINITY },
      nested: { deep: { flag: true }, none: null },
      text: 'quoted: yes # not a comment',
      expression: "pricing['features']['solve'] && ready",
      version: '0.1.0',
      price: 0,
    });
  });

  it('expands anchors and merges, with the explicit keys winning', () => {
    const document = parseYaml([
      'base: &base',
      '  a: { value: 1 }',
      '  b: { value: 2 }',
      'copy:',
      '  <<: *base',
      '  b: { value: 3 }',
      '  c: { value: 4 }',
    ].join('\n'));
    expect(document).toEqual({
      base: { a: { value: 1 }, b: { value: 2 } },
      copy: { a: { value: 1 }, b: { value: 3 }, c: { value: 4 } },
    });
  });

  it('reads sequences of scalars and of mappings', () => {
    expect(parseYaml(['items:', '  - one', '  - name: two', '    size: 2', 'tail: ok'].join('\n'))).toEqual({
      items: ['one', { name: 'two', size: 2 }],
      tail: 'ok',
    });
  });

  it('keeps a number larger than pricing4ts allows', () => {
    expect(parseYaml('limit: { value: 21474836480 }')).toEqual({ limit: { value: 21474836480 } });
  });

  it('refuses what it does not understand instead of guessing', () => {
    expect(() => parseYaml('text: |\n  block')).toThrow(YamlError);
    expect(() => parseYaml('a: *missing')).toThrow(/no anchor/);
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/tabs/);
    expect(() => parseYaml('a: { b: 1')).toThrow(YamlError);
  });
});

describe('pricingYaml · writing', () => {
  it('writes small mappings on one line, the way the pricing files do', () => {
    const map: YamlMap = { a: 1, b: { c: 'x y', d: [1, 2] }, e: { f: { value: Number.POSITIVE_INFINITY } }, g: 'true', h: '0.1.0' };
    expect(emitYamlMap(map)).toBe(['a: 1', 'b: { c: x y, d: [1, 2] }', 'e:', '  f: { value: .inf }', 'g: "true"', 'h: "0.1.0"'].join('\n'));
  });

  it('reads back what it wrote', () => {
    const map: YamlMap = {
      description: 'Contact us / Institutional agreement. Larger: capacity',
      price: 12.5,
      features: { solve: { value: true } },
      usageLimits: { taskStarts: { value: Number.POSITIVE_INFINITY }, storageBytes: { value: 21474836480 } },
      availableFor: ['ADVANCED', 'PRO'],
    };
    expect(parseYaml(emitYamlMap(map))).toEqual(map);
  });

  it('replaces one top-level section and keeps the rest as it was written', () => {
    const source = 'version: 0.1.0\n\nplans:\n  A:\n    price: 0\n\n# the add-ons\naddOns:\n  X:\n    unit: u\n';
    expect(replaceYamlSection(source, 'plans', '  B:\n    price: 1')).toBe('version: 0.1.0\n\nplans:\n  B:\n    price: 1\n\n# the add-ons\naddOns:\n  X:\n    unit: u\n');
    expect(replaceYamlSection(source, 'addOns', '')).toBe('version: 0.1.0\n\nplans:\n  A:\n    price: 0\n\n# the add-ons\n');
    expect(replaceYamlSection('version: 1\n', 'addOns', '  X:\n    unit: u')).toBe('version: 1\n\naddOns:\n  X:\n    unit: u\n');
  });

  it('replaces the version line only', () => {
    expect(replaceYamlVersion('syntaxVersion: 3\nversion: 0.1.0\n', '0.2.0-draft.1')).toBe('syntaxVersion: 3\nversion: 0.2.0-draft.1\n');
    expect(() => replaceYamlVersion('name: x\n', '0.2.0')).toThrow(YamlError);
  });
});
