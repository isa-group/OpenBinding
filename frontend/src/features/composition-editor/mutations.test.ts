import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_KEYS, PROVENANCE_REMOVED, offeringChoice, removeValue, setCandidate, setKind, setOffering, setValue, setVersion,
  type DocumentModel,
} from './mutations';

/** src/test/fixtures/compositions/declared.yaml as the gateway parses it. */
const declared = (): DocumentModel => ({
  syntaxVersion: '1.0',
  composition: 'order-desk',
  version: '1.0.0',
  kind: 'application',
  workflow: { seq: ['signIn', { and: ['notify', 'archive'] }, { xor: [{ probability: 0.7, flow: 'post' }, { probability: 0.3, flow: 'courier' }] }] },
  binding: {
    signIn: { local: true },
    notify: { candidate: 'email.brevo.starter', from: { sphere: 'brevo/brevo', version: '665f1c2e9b1d4a0012ab34cd', plan: 'STARTER' } },
    archive: { candidate: 'storage.dropbox.plus' },
    post: { candidate: 'shipping.post.standard' },
    courier: { candidate: 'shipping.courier.express' },
  },
  values: { availability: 0.995, cost: { value: 42.5, unit: 'EUR/month' }, latency: { value: 380, unit: 'ms' } },
  offering: { url: 'https://pricings.example.org/order-desk/pricing.yml' },
});

const EVERY_MUTATION: Array<[string, (document: DocumentModel) => DocumentModel]> = [
  ['version', (document) => setVersion(document, '1.1.0')],
  ['kind', (document) => setKind(document, 'pipeline')],
  ['candidate', (document) => setCandidate(document, 'notify', 'email.mailgun.basic').document],
  ['value', (document) => setValue(document, 'cost', 40, 'EUR/month')],
  ['new value', (document) => setValue(document, 'reliability', 0.99, '1')],
  ['removed value', (document) => removeValue(document, 'latency')],
  ['sphere offering', (document) => setOffering(document, { source: 'sphere', sphere: 'acme/order-desk' })],
  ['registry offering', (document) => setOffering(document, { source: 'registry', sphere: 'acme/order-desk', registry: 'onprem' })],
  ['url offering', (document) => setOffering(document, { source: 'url', url: 'https://example.org/p.yml' })],
  ['no offering', (document) => setOffering(document, null)],
];

describe('the visual editor’s changes', () => {
  it('knows the keys of the language exactly as the gateway’s schema names them', () => {
    const schema = JSON.parse(readFileSync(
      join(process.cwd(), '../openbinding-gateway/src/openbinding_gateway/composition/resources/composition2yaml/1.0/composition.schema.json'), 'utf8',
    )) as { properties: Record<string, unknown> };
    expect([...DOCUMENT_KEYS].sort()).toEqual(Object.keys(schema.properties).sort());
  });

  it.each(EVERY_MUTATION)('%s: answers a new document with Composition2Yaml keys only, never a presentation hint', (_name, mutate) => {
    const before = declared();
    const after = mutate(before);
    expect(before).toEqual(declared());
    expect(after).not.toBe(before);
    for (const key of Object.keys(after)) expect(DOCUMENT_KEYS as readonly string[]).toContain(key);
    expect(after).not.toHaveProperty('presentation');
    expect(JSON.stringify(after)).not.toMatch(/presentation/);
  });

  it('sets the label and the kind', () => {
    expect(setVersion(declared(), '2.0.0').version).toBe('2.0.0');
    expect(setKind(declared(), 'system').kind).toBe('system');
  });

  it('binds a task to a candidate and drops the provenance of the old one, saying so', () => {
    const changed = setCandidate(declared(), 'notify', 'email.mailgun.basic');
    expect((changed.document.binding as Record<string, unknown>).notify).toEqual({ candidate: 'email.mailgun.basic' });
    expect(changed.note).toBe(PROVENANCE_REMOVED);

    const plain = setCandidate(declared(), 'archive', 'storage.box.business');
    expect((plain.document.binding as Record<string, unknown>).archive).toEqual({ candidate: 'storage.box.business' });
    expect(plain.note).toBeNull();
    // A task done in house becomes a bound one, and the other tasks stay as they were.
    const local = setCandidate(declared(), 'signIn', 'auth.okta.basic').document.binding as Record<string, unknown>;
    expect(local.signIn).toEqual({ candidate: 'auth.okta.basic' });
    expect(local.post).toEqual({ candidate: 'shipping.post.standard' });
  });

  it('declares a value with its unit, a dimensionless one as a bare number, and removes one', () => {
    expect((setValue(declared(), 'cost', 40, ' EUR/month ').values as Record<string, unknown>).cost).toEqual({ value: 40, unit: 'EUR/month' });
    expect((setValue(declared(), 'availability', 0.99, '1').values as Record<string, unknown>).availability).toBe(0.99);
    expect((setValue(declared(), 'availability', 0.98, '').values as Record<string, unknown>).availability).toBe(0.98);
    expect(removeValue(declared(), 'latency').values).toEqual({ availability: 0.995, cost: { value: 42.5, unit: 'EUR/month' } });
  });

  it('writes the offering in one of its three forms, or none, and reads it back as a choice', () => {
    expect(setOffering(declared(), { source: 'sphere', sphere: 'acme/desk' }).offering).toEqual({ sphere: 'acme/desk' });
    expect(setOffering(declared(), { source: 'registry', sphere: 'acme/desk', registry: 'onprem' }).offering).toEqual({ sphere: 'acme/desk', registry: 'onprem' });
    expect(setOffering(declared(), { source: 'url', url: 'https://example.org/p.yml' }).offering).toEqual({ url: 'https://example.org/p.yml' });
    expect(setOffering(declared(), null)).not.toHaveProperty('offering');

    expect(offeringChoice(declared())).toEqual({ source: 'url', url: 'https://pricings.example.org/order-desk/pricing.yml' });
    expect(offeringChoice({ offering: { sphere: 'a/b', registry: 'r' } })).toEqual({ source: 'registry', sphere: 'a/b', registry: 'r' });
    expect(offeringChoice({ offering: { sphere: 'a/b' } })).toEqual({ source: 'sphere', sphere: 'a/b' });
    expect(offeringChoice({})).toBeNull();
  });
});
