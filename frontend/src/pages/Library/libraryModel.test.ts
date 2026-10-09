import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { associateRefusal, contentFailure, createRefusal, classifyAuthError, publishRefusal, saveRefusal, sealRefusal, withdrawRefusal } from './libraryErrors';
import { citationOf, exactReference, findVersion, fixedName, itemKey, kindLabel, mediaKindOf, newestFirst, publicationOf, versionPath } from './libraryModel';
import { digestOf, itemOf, versionOf } from './fixtures';

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

describe('library addresses and labels', () => {
  const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE');
  const foreign = itemOf('providers-eu', 'CandidateCatalog', 'Theirs', { id: 'item-theirs', organization_id: 'org-other' });

  it('names an own item by its fixed name when that is unambiguous, and anything else by its id', () => {
    expect(itemKey(catalog, 'org-isa-demo', [catalog])).toBe('providers-eu');
    expect(itemKey(catalog, 'org-isa-demo', [catalog, foreign])).toBe('providers-eu');
    expect(itemKey(foreign, 'org-isa-demo', [catalog, foreign])).toBe('item-theirs');
    expect(itemKey(catalog, 'org-isa-demo', [catalog, { ...catalog, id: 'twin' }])).toBe(catalog.id);
  });

  it('finds a version by its label or its id', () => {
    const two = versionOf(catalog, '2');
    const three = versionOf(catalog, '3');
    expect(findVersion([two, three], '3')).toBe(three);
    expect(findVersion([two, three], two.id)).toBe(two);
    expect(findVersion([two, three], '9')).toBeUndefined();
    expect(newestFirst([two, three]).map((version) => version.ref.version)).toEqual(['3', '2']);
    expect(versionPath('isa-demo', 'providers-eu', '3')).toBe('/app/isa-demo/library/providers-eu/versions/3');
  });

  it('tells members-only, published and withdrawn apart', () => {
    expect(publicationOf({ public: false, withdrawn: false })).toBe('members');
    expect(publicationOf({ public: true, withdrawn: false })).toBe('published');
    expect(publicationOf({ public: true, withdrawn: true })).toBe('withdrawn');
  });

  it('spells kinds, fixed names and media types', () => {
    expect(kindLabel('ConstraintSet')).toBe('Rules');
    expect(kindLabel('Something')).toBe('Something');
    expect(fixedName('Mi Catálogo_2')).toBe('mi-cat-logo_2');
    expect([mediaKindOf('application/json'), mediaKindOf('application/vnd.omg.bpmn+xml'), mediaKindOf('text/plain'), mediaKindOf(undefined)]).toEqual(['json', 'xml', 'text', 'json']);
  });

  it('writes the exact reference and a citation from what the gateway returned', () => {
    const version = versionOf(catalog, '3');
    expect(exactReference(version)).toBe(`org-isa-demo/providers-eu@3 ${version.ref.versionDigest}`);
    const citation = citationOf(catalog, version, 'ISA Demo Group', 'Catálogo de proveedores UE', 'https://openbinding.example');
    expect(citation.text).toContain('ISA Demo Group (2026). Catálogo de proveedores UE, version 3.');
    expect(citation.text).toContain('candidate catalog');
    expect(citation.bibtex).toContain(`https://openbinding.example/resolve/artifact/${version.ref.versionDigest}`);
  });
});

describe('what each refusal says', () => {
  it('names the 409 and the pricing 422 of a new item', () => {
    expect(createRefusal(refusal(409, 'artifact_exists'), { kind: 'CandidateCatalog', name: 'providers-eu' }).text)
      .toBe('There’s already a Candidate catalog called “providers-eu” here (409 · artifact_exists). Pick another fixed name.');
    expect(createRefusal(refusal(422, 'operational_pricing_only'), { kind: 'PricingDocument', name: 'x' }).text)
      .toContain('Pricing documents can’t live in the library (422 · operational_pricing_only)');
    expect(createRefusal(refusal(403, 'api_key_boundary'), { kind: 'Study', name: 'x' }).text).toContain('limited to other organizations or kinds');
    expect(createRefusal(refusal(403, 'forbidden'), { kind: 'Study', name: 'x' }).text).toContain('You need MEMBER');
  });

  it('separates the draft conflict from a forbidden save and an invalid one', () => {
    expect(saveRefusal(refusal(409, 'draft_conflict')).kind).toBe('conflict');
    expect(saveRefusal(refusal(403, 'forbidden')).kind).toBe('forbidden');
    expect(saveRefusal(refusal(422, 'invalid_content', 'JSON content must be an object.')).text).toContain('JSON content must be an object.');
  });

  it('separates a taken version label from a moved draft when sealing', () => {
    expect(sealRefusal(refusal(409, 'version_conflict'), '3')).toMatchObject({ kind: 'version', text: 'Version 3 already exists (409 · version_conflict). Choose another label.' });
    expect(sealRefusal(refusal(409, 'draft_conflict'), '').kind).toBe('conflict');
    expect(sealRefusal(refusal(422, 'invalid_resource'), '').kind).toBe('invalid');
  });

  it('knows each way publishing is refused', () => {
    expect(publishRefusal(refusal(422, 'private_dependency')).kind).toBe('dependency');
    expect(publishRefusal(refusal(422, 'private_engine_dependency')).kind).toBe('engine');
    expect(publishRefusal(refusal(422, 'private_evidence')).kind).toBe('evidence');
    expect(publishRefusal(refusal(422, 'private_case_dependency')).kind).toBe('case');
    expect(publishRefusal(refusal(409, 'publication_withdrawn')).kind).toBe('withdrawn');
    expect(publishRefusal(refusal(409, 'version_integrity')).kind).toBe('integrity');
    expect(publishRefusal(refusal(403, 'forbidden')).kind).toBe('forbidden');
    expect(withdrawRefusal(refusal(409, 'x')).kind).toBe('withdrawn');
  });

  it('reads a private item added from another organization', () => {
    expect(associateRefusal(refusal(422, 'private_dependency'), 'Catálogo externo').text)
      .toBe('“Catálogo externo” belongs to another organization and isn’t published (422 · private_dependency). Ask its owners to publish a version first.');
  });

  it('tells a broken seal from a missing version', () => {
    expect(contentFailure(classifyAuthError(refusal(409, 'content_integrity')))).toBe('integrity');
    expect(contentFailure(classifyAuthError(refusal(404, 'not_found')))).toBe('missing');
    expect(contentFailure(classifyAuthError(refusal(503, 'x')))).toBe('other');
    expect(digestOf('a')).toMatch(/^sha256-a{64}$/);
  });
});
