import { describe, expect, it } from 'vitest';
import {
  addCandidate, addRule, brief, catalogOf, checksFor, differences, freezeLines, parseContent, parseNumber, removeCandidate, renameCandidate, rulesOf,
  setCandidateFeature, setCandidateProvider, setRuleField, summarizeXml, templateFor, updateAt, type Json, type JsonObject,
} from './contentModel';
import { bpmnContent, catalogContent, rulesContent } from './fixtures';

const catalog = () => catalogContent() as JsonObject;

describe('candidate catalogs as rows', () => {
  it('groups candidates by the capability they provide and collects the qualities in order', () => {
    const view = catalogOf(catalog());
    expect(view?.columns).toEqual(['latency_ms', 'cost_eur', 'availability']);
    expect(view?.groups.map((group) => [group.capability, group.rows.map((row) => row.id)])).toEqual([
      ['service/payment', ['payco-eu', 'fastpay']], ['service/stock', ['stockly-1']],
    ]);
    expect(view?.groups[0].rows[0]).toEqual({ id: 'payco-eu', provider: 'payco', features: { latency_ms: 180, cost_eur: 0.021, availability: 99.95 } });
  });

  it('leaves a catalog it cannot show as a table to the generic form', () => {
    const rich = updateAt(catalog(), ['spec', 'candidates', 'fastpay', 'provides'], ['payment', 'stock']);
    expect(catalogOf(rich)).toBeNull();
    const at = (value: Json) => updateAt(catalog(), ['spec', 'candidates', 'fastpay', 'features', 'latency_ms'], value);
    // A scalar that is null, a range with another key, and a text are not qualities a table can hold.
    expect(catalogOf(at(null))).toBeNull();
    expect(catalogOf(at({ min: 1, max: 2, mid: 1 }))).toBeNull();
    expect(catalogOf(at('fast'))).toBeNull();
    expect(catalogOf('<xml/>')).toBeNull();
    expect(catalogOf({ spec: {} })).toBeNull();
  });

  it('shows a quality that is a range, open or not, as a row of the table', () => {
    const at = (value: Json) => updateAt(catalog(), ['spec', 'candidates', 'fastpay', 'features', 'latency_ms'], value);
    for (const range of [{ min: 1, max: 2 }, { min: null, max: 2 }, { min: 1, max: null }, { min: null, max: null }]) {
      expect(catalogOf(at(range))?.groups[0].rows[1].features.latency_ms).toEqual(range);
    }
  });

  it('writes a range with its ends in order and removes a quality with null', () => {
    const open = setCandidateFeature(catalog(), 'fastpay', 'latency_ms', { max: null, min: 100 });
    expect(JSON.stringify(((open.spec as JsonObject).candidates as JsonObject).fastpay)).toContain('"latency_ms":{"min":100,"max":null}');
    // An end that isn't known yet is left out, so the slot stays invalid until it is typed.
    const partial = setCandidateFeature(catalog(), 'fastpay', 'latency_ms', { min: 5 });
    expect(catalogOf(partial)?.groups[0].rows[1].features.latency_ms).toEqual({ min: 5 });
    expect(catalogOf(setCandidateFeature(open, 'fastpay', 'latency_ms', 7))?.groups[0].rows[1].features.latency_ms).toBe(7);
    expect('latency_ms' in (catalogOf(setCandidateFeature(open, 'fastpay', 'latency_ms', null))?.groups[0].rows[1].features ?? {})).toBe(false);
  });

  it('blocks sealing on a range that is not valid, and only on that', () => {
    const wrong = setCandidateFeature(catalog(), 'fastpay', 'latency_ms', { min: 9, max: 3 });
    const checks = checksFor('CandidateCatalog', wrong);
    const range = checks.find((check) => check.blocking);
    expect(range).toMatchObject({ level: 'error' });
    expect(range?.text).toContain('fastpay · latency_ms: Min can’t be greater than max.');
    expect(checksFor('CandidateCatalog', setCandidateFeature(catalog(), 'fastpay', 'latency_ms', { min: 5 })).some((check) => check.blocking)).toBe(true);
    // Open ends never trigger an order error; a missing quality is the gateway's call, not a block.
    expect(checksFor('CandidateCatalog', setCandidateFeature(catalog(), 'fastpay', 'latency_ms', { min: 5, max: null })).some((check) => check.blocking)).toBe(false);
    expect(checksFor('CandidateCatalog', setCandidateFeature(catalog(), 'fastpay', 'latency_ms', null)).some((check) => check.blocking)).toBe(false);
  });

  it('counts the qualities that are ranges', () => {
    const open = setCandidateFeature(setCandidateFeature(catalog(), 'fastpay', 'latency_ms', { min: null, max: 90 }), 'payco-eu', 'cost_eur', { min: null, max: null });
    expect(checksFor('CandidateCatalog', open)).toContainEqual({ level: 'ok', text: '2 qualities are ranges' });
    expect(checksFor('CandidateCatalog', catalog()).some((check) => check.text.includes('range'))).toBe(false);
  });

  it('reads a range in a generic table as the range it is', () => {
    expect(brief({ min: null, max: 200 })).toBe('≤ 200');
    expect(brief({ min: 1, max: 2 })).toBe('1–2');
  });

  it('edits one cell at a time and keeps what it does not know about', () => {
    const edited = setCandidateFeature(catalog(), 'fastpay', 'latency_ms', 90);
    expect(catalogOf(edited)?.groups[0].rows[1].features.latency_ms).toBe(90);
    const cleared = setCandidateFeature(edited, 'fastpay', 'latency_ms', null);
    expect('latency_ms' in (catalogOf(cleared)?.groups[0].rows[1].features ?? {})).toBe(false);
    const provider = setCandidateProvider(catalog(), 'fastpay', 'fast-pay');
    expect(catalogOf(provider)?.groups[0].rows[1].provider).toBe('fast-pay');
    expect(((provider.spec as JsonObject).candidates as JsonObject).fastpay).toMatchObject({ provider: { resource: 'catalog', id: 'fast-pay' } });
  });

  it('renames a candidate in place and refuses a name already used', () => {
    const renamed = renameCandidate(catalog(), 'fastpay', 'quick-pay');
    expect(Object.keys((renamed.spec as JsonObject).candidates as JsonObject)).toEqual(['payco-eu', 'quick-pay', 'stockly-1']);
    expect(renameCandidate(catalog(), 'fastpay', 'payco-eu')).toEqual(catalog());
    expect(renameCandidate(catalog(), 'fastpay', '  ')).toEqual(catalog());
  });

  it('adds and removes candidates with unused names', () => {
    const once = addCandidate(catalog(), 'service/payment');
    const twice = addCandidate(once, 'service/payment');
    expect(Object.keys((twice.spec as JsonObject).candidates as JsonObject).slice(-2)).toEqual(['new-provider', 'new-provider-2']);
    expect(Object.keys(((removeCandidate(twice, 'new-provider').spec as JsonObject).candidates as JsonObject))).not.toContain('new-provider');
  });
});

describe('rules as rows', () => {
  it('reads conditions, enforcement and penalties', () => {
    expect(rulesOf(rulesContent())).toEqual([
      { id: 'sla-latency', condition: 'features.latency_ms <= 600', enforcement: 'hard', penalty: null },
      { id: 'sla-availability', condition: 'features.availability >= 99.9', enforcement: 'soft', penalty: 5 },
    ]);
  });

  it('does not flatten rules whose condition is a structure', () => {
    expect(rulesOf({ spec: { constraints: { a: { assert: {}, enforcement: 'hard' } } } })).toBeNull();
    expect(rulesOf({ spec: { constraints: [{ assert: 'x', enforcement: 'hard' }] } })).toBeNull();
  });

  it('adds a rule and changes a field', () => {
    const added = addRule(rulesContent());
    expect(rulesOf(added)?.at(-1)).toEqual({ id: 'new-rule', condition: '', enforcement: 'hard', penalty: null });
    const edited = setRuleField(added, 'new-rule', 'assert', 'features.cost_eur <= 1');
    expect(rulesOf(edited)?.at(-1)?.condition).toBe('features.cost_eur <= 1');
  });
});

describe('checks before sealing', () => {
  it('flags a provider missing a quality and counts the rest', () => {
    const missing = setCandidateFeature(catalog(), 'fastpay', 'cost_eur', null);
    const checks = checksFor('CandidateCatalog', missing);
    expect(checks.find((check) => check.level === 'error')?.text).toBe('1 provider is missing a quality');
    expect(checks[0]).toEqual({ level: 'ok', text: '3 providers in 2 capabilities' });
  });

  it('warns about an empty catalog and rules without a condition', () => {
    expect(checksFor('CandidateCatalog', templateFor('CandidateCatalog', 'x').content)[0]).toEqual({ level: 'warn', text: 'No providers yet' });
    const blank = addRule(templateFor('ConstraintSet', 'x').content as JsonObject);
    expect(checksFor('ConstraintSet', blank).map((check) => check.text)).toContain('1 rule has no condition');
  });

  it('requires an exact engine for run settings and content for the kinds that cannot be empty', () => {
    const texts = checksFor('ExecutionConfiguration', templateFor('ExecutionConfiguration', 'x').content).map((check) => check.text);
    expect(texts).toContain('The engine needs its namespace, name, version and digest');
    expect(texts).toContain('Choose the engine mode');
    expect(checksFor('Report', {})[0]).toEqual({ level: 'error', text: 'The content can’t be empty for this kind' });
    expect(checksFor('Dataset', {})[0].level).toBe('ok');
  });

  it('reads the tasks of a workflow file', () => {
    expect(checksFor('BPMN', bpmnContent).map((check) => check.text)).toContain('Well-formed XML with 2 tasks');
    expect(checksFor('BPMN', '<bpmn:definitions').some((check) => check.level === 'error')).toBe(true);
  });
});

describe('describing and comparing', () => {
  it('summarizes an XML file without opening it', () => {
    const summary = summarizeXml(bpmnContent);
    expect(summary).toMatchObject({ ok: true, root: 'definitions', tasks: 2, lines: 7 });
    expect(summary.bytes).toBeGreaterThan(200);
  });

  it('lists the fields that differ, by name', () => {
    const theirs = setCandidateFeature(catalog(), 'fastpay', 'latency_ms', 90);
    const mine = setCandidateFeature(catalog(), 'fastpay', 'latency_ms', 99);
    expect(differences(mine, theirs)).toEqual([{ field: 'candidates · fastpay · features · latency_ms', mine: '99', theirs: '90' }]);
    expect(differences(catalog(), catalog())).toEqual([]);
    expect(differences('a\nb', 'a')).toEqual([{ field: 'File', mine: '2 lines', theirs: '1 line' }]);
  });

  it('says what sealing freezes', () => {
    expect(freezeLines('CandidateCatalog', catalog(), 0, '3')).toEqual([
      '3 providers in 2 capabilities, and their qualities', 'The language qos-binding/v1', 'Everything in version 3 that you didn’t change',
    ]);
    expect(freezeLines('ConstraintSet', rulesContent(), 1, null)).toContain('1 exact dependency');
  });
});

describe('small helpers', () => {
  it('reads numbers as they are typed', () => {
    expect([parseNumber('0.5'), parseNumber(' -3 '), parseNumber('1e-4'), parseNumber('.5'), parseNumber('5.')]).toEqual([0.5, -3, 0.0001, 0.5, 5]);
    expect([parseNumber(''), parseNumber('abc'), parseNumber('1,5'), parseNumber('--1')]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('parses JSON content and falls back to text', () => {
    expect(parseContent('{"a":1}', 'application/json')).toEqual({ a: 1 });
    expect(parseContent('[1]', 'application/json')).toBe('[1]');
    expect(parseContent('<a/>', 'application/xml')).toBe('<a/>');
  });

  it('gives each kind a start shaped for it', () => {
    expect(templateFor('CandidateCatalog', 'providers-eu')).toEqual({
      content: { apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', metadata: { name: 'providers-eu' }, spec: { featureBindings: {}, candidates: {} } }, mediaType: 'application/json',
    });
    expect(templateFor('Application', 'app').content).toEqual({
      apiVersion: 'qos-binding/v1', kind: 'Application', metadata: { name: 'app' }, spec: { tasks: {}, features: {}, workflow: {} },
    });
    expect(templateFor('Optimization', 'goal').content).toEqual({
      apiVersion: 'qos-binding/v1', kind: 'Optimization', metadata: { name: 'goal' }, spec: { criteria: [], penalties: [] },
    });
    expect(templateFor('ConstraintSet', 'rules').content).toEqual({
      apiVersion: 'qos-binding/v1', kind: 'ConstraintSet', metadata: { name: 'rules' }, spec: { constraints: {} },
    });
    expect(templateFor('RoutingOverlay', 'routing').content).toEqual({
      apiVersion: 'qos-binding/v1', kind: 'RoutingOverlay', metadata: { name: 'routing' }, spec: { uniform: true },
    });
    expect(templateFor('Placement', 'place').content).toEqual({
      apiVersion: 'qos-binding-placement/v1', kind: 'Placement', metadata: { name: 'place' }, spec: { pools: {} },
    });
    expect(templateFor('Collection', 'x').content).toEqual({ apiVersion: 'openbinding/collection/v1', members: [] });
    expect(templateFor('BPMN', 'x').mediaType).toBe('application/vnd.omg.bpmn+xml');
    expect(templateFor('Whatever', 'x').content).toEqual({});
  });

  it('updates a path without touching the original', () => {
    const original = catalog();
    const next = updateAt(original, ['spec', 'candidates', 'fastpay', 'features', 'latency_ms'], 1);
    expect(original).toEqual(catalogContent());
    expect(next).not.toBe(original);
    expect(updateAt({ list: [1, 2, 3] }, ['list', 1], undefined)).toEqual({ list: [1, 3] });
  });
});
