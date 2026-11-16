import { describe, expect, it } from 'vitest';
import ambiguous from '../../test/fixtures/core/ambiguous.version.json';
import fms from '../../test/fixtures/core/fms.version.json';
import jsonComplete from '../../test/fixtures/core/json-complete.version.json';
import { documentValue, isCompositionDocument, readDocument } from './document';

const minimal = {
  syntaxVersion: '1.0',
  composition: 'shop',
  version: '1.0.0',
  kind: 'application',
  workflow: 'pick',
  binding: { pick: { candidate: 'c_pick' } },
  values: {},
};

describe('readDocument', () => {
  it('reads the documents the gateway serves', () => {
    for (const version of [fms, ambiguous, jsonComplete])
      expect(readDocument(version.document)).toBe(version.document);
  });

  it('reads provenance, an offering, local tasks and both value forms', () => {
    const document = {
      ...minimal,
      binding: {
        pick: {
          candidate: 'c_pick',
          from: {
            sphere: 'acme/picking',
            registry: 'lab',
            version: 'v7',
            plan: 'Pro',
            addons: ['SSO'],
          },
        },
        pack: { local: true },
      },
      values: { availability: 0.99, cost: { value: 4.5, unit: 'EUR' } },
      offering: { url: 'https://pricings.example.org/shop/pricing.yml' },
    };
    expect(isCompositionDocument(document)).toBe(true);
  });

  it('refuses what does not have the shape of a document', () => {
    expect(readDocument(null)).toBeNull();
    expect(readDocument({ ...minimal, kind: 'service' })).toBeNull();
    expect(readDocument({ ...minimal, values: { encrypted: true } })).toBeNull();
    expect(
      readDocument({
        ...minimal,
        binding: { pick: { local: true, from: { sphere: 'a/b', version: 'v', plan: 'p' } } },
      })
    ).toBeNull();
    expect(
      readDocument({ ...minimal, offering: { url: 'https://x.example.org/p.yml', sphere: 'a/b' } })
    ).toBeNull();
    const noWorkflow: Record<string, unknown> = { ...minimal };
    delete noWorkflow.workflow;
    expect(readDocument(noWorkflow)).toBeNull();
  });

  it('keeps an unknown workflow shape for the graph to show as unreadable', () => {
    expect(readDocument({ ...minimal, workflow: { fork: ['a'] } })).not.toBeNull();
  });
});

describe('documentValue', () => {
  it('gives a bare number the unit "1" and keeps a written unit', () => {
    expect(documentValue(0.99)).toEqual({ value: 0.99, unit: '1' });
    expect(documentValue({ value: 30, unit: 'ms' })).toEqual({ value: 30, unit: 'ms' });
  });
});
