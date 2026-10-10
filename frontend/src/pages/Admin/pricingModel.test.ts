import { describe, expect, it } from 'vitest';
import { HttpError } from '../../api/client';
import { DRAFT_RELEASE, DRAINING_RELEASE, LIVE_RELEASE, PRICING_SOURCE, previewOf } from './pricingFixtures';
import {
  blankAddOn, buildYaml, describePricingFailure, diffPricing, editFrom, issuesOf, lifecycleOf, limitText, parseLimitInput, readPricing, readValidation,
  tryReadPricing,
} from './pricingModel';

const doc = readPricing(PRICING_SOURCE);

describe('pricingModel · reading a document', () => {
  it('reads plans, limits, features and add-ons as written, merges and unlimited included', () => {
    expect(doc.version).toBe('0.1.0');
    expect(doc.currency).toBe('EUR');
    expect(doc.plans.map((plan) => plan.id)).toEqual(['BASIC', 'ADVANCED', 'PRO']);
    expect(doc.limits.map((limit) => limit.id)).toEqual(['taskStarts', 'concurrentJobs', 'storageBytes']);
    const pro = doc.plans.find((plan) => plan.id === 'PRO')!;
    expect(pro.limits.taskStarts).toBeNull();
    expect(pro.limits.storageBytes).toBe(21474836480);
    expect(pro.features).toEqual({ solve: true, advancedAnalytics: true });
    expect(doc.plans[0].features).toEqual({ solve: true, advancedAnalytics: false });
    expect(doc.plans[0].price).toBe(0);
    expect(doc.addOns).toHaveLength(1);
    expect(doc.addOns[0]).toMatchObject({ id: 'COMPUTE_PACK', availableFor: ['ADVANCED', 'PRO'], min: 1, max: 10, step: 1, extensions: { taskStarts: 100 } });
  });

  it('does not turn a 20 GiB limit into no limit', () => {
    expect(limitText(doc, 'storageBytes', 21474836480)).toBe('20 GiB');
    expect(limitText(doc, 'taskStarts', null)).toBe('Unlimited');
  });

  it('says what could not be read instead of throwing', () => {
    expect(tryReadPricing('plans: [')).toHaveProperty('error');
    expect(tryReadPricing('- not a document')).toHaveProperty('error');
    expect(tryReadPricing(PRICING_SOURCE)).toHaveProperty('doc');
  });
});

describe('pricingModel · comparing', () => {
  it('lists what a version changes against another, with the direction', () => {
    const changes = diffPricing(doc, readPricing(previewOf('0.2.0-draft.1')));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ scope: 'limit', plan: 'PRO', label: 'Concurrent jobs', before: '8', after: '10', direction: 'up' });
  });

  it('finds nothing between a document and itself', () => {
    expect(diffPricing(doc, doc)).toEqual([]);
  });
});

describe('pricingModel · editing a draft', () => {
  it('writes the document back unchanged when nothing was edited, under the new version', () => {
    const yaml = buildYaml(doc, editFrom(doc), '0.2.0-draft.1');
    const again = readPricing(yaml);
    expect(again.version).toBe('0.2.0-draft.1');
    expect(diffPricing(doc, again)).toEqual([]);
    // What the form does not edit stays as it was written, comments included.
    expect(yaml).toContain('# OpenBinding platform pricing, version 0.1.0.');
    expect(yaml).toContain("expression: pricingContext['features']['solve']");
    expect(yaml).toContain('storageBytes: { value: 21474836480 }');
    expect(yaml).toContain('taskStarts: { value: .inf }');
  });

  it('applies edited limits, features and add-ons', () => {
    const edit = editFrom(doc);
    edit.plans[0].limits.taskStarts = '20';
    edit.plans[2].limits.taskStarts = '500';
    edit.plans[0].features.advancedAnalytics = true;
    edit.addOns[0].max = '12';
    edit.addOns.push({ ...blankAddOn(doc), id: 'STORAGE_PACK', description: 'Adds 5 GB.', availableFor: ['PRO'], extensions: { storageBytes: '5368709120' } });
    const again = readPricing(buildYaml(doc, edit, '0.2.0-draft.1'));
    const changes = diffPricing(doc, again);
    const byId = (id: string) => changes.find((change) => change.id === id);
    expect(byId('limit:BASIC:taskStarts')).toMatchObject({ before: '10', after: '20', direction: 'up' });
    expect(byId('limit:PRO:taskStarts')).toMatchObject({ before: 'Unlimited', after: '500', direction: 'down' });
    expect(byId('feature:BASIC:advancedAnalytics')).toMatchObject({ before: 'Not included', after: 'Included' });
    expect(byId('addon:STORAGE_PACK')).toMatchObject({ before: 'Not offered', after: 'Offered' });
    expect(byId('addon:COMPUTE_PACK:Quantity')).toMatchObject({ before: '1–10 step 1', after: '1–12 step 1' });
    expect(again.addOns.find((addOn) => addOn.id === 'STORAGE_PACK')?.extensions).toEqual({ storageBytes: 5368709120 });
  });

  it('removes an add-on and the whole section when none is left', () => {
    const edit = editFrom(doc);
    edit.addOns = [];
    const yaml = buildYaml(doc, edit, '0.2.0-draft.1');
    expect(yaml).not.toContain('addOns:');
    expect(readPricing(yaml).addOns).toEqual([]);
  });

  it('accepts a figure or “unlimited” and nothing else', () => {
    expect(parseLimitInput('25')).toBe(25);
    expect(parseLimitInput(' 2.5 ')).toBe(2.5);
    expect(parseLimitInput('Unlimited')).toBeNull();
    expect(parseLimitInput('∞')).toBeNull();
    expect(parseLimitInput('')).toBeUndefined();
    expect(parseLimitInput('-3')).toBeUndefined();
    expect(parseLimitInput('12x')).toBeUndefined();
  });

  it('names what is wrong before the gateway is asked', () => {
    const edit = editFrom(doc);
    expect(issuesOf(doc, edit)).toEqual([]);
    edit.plans[0].limits.taskStarts = 'lots';
    edit.addOns.push(blankAddOn(doc));
    const issues = issuesOf(doc, edit);
    expect(issues).toContainEqual({ where: 'BASIC · Solves', text: 'Use a whole number or “unlimited”.' });
    expect(issues.some((issue) => issue.where === 'Add-on (unnamed)' && /id of letters/.test(issue.text))).toBe(true);
    expect(issues.some((issue) => /adds to at least one limit/.test(issue.text))).toBe(true);
    edit.addOns[1] = { ...edit.addOns[1], id: 'COMPUTE_PACK', extensions: { taskStarts: '5' } };
    expect(issuesOf(doc, edit).some((issue) => /Another add-on has this id/.test(issue.text))).toBe(true);
  });
});

describe('pricingModel · what the gateway says', () => {
  it('reads a verdict', () => {
    expect(readValidation({ valid: true, version: '0.2.0-draft.1', digest: 'sha256-x', plans: ['BASIC'], add_ons: ['A'], errors: [], warnings: ['w'] })).toEqual({
      valid: true, version: '0.2.0-draft.1', digest: 'sha256-x', plans: ['BASIC'], addOns: ['A'], errors: [], warnings: ['w'], refused: false,
    });
    expect(readValidation({ valid: false, errors: ['plans.BASIC: missing price'] })).toMatchObject({ valid: false, errors: ['plans.BASIC: missing price'], refused: false });
  });

  it('reads a 422 as a refusal with the reasons it lists', () => {
    expect(readValidation({ code: 'validation_error', detail: 'Request validation failed: /yaml: Field required', diagnostics: [{ code: 'missing', message: 'Field required', pointer: '/yaml' }] }))
      .toMatchObject({ valid: false, refused: true, errors: ['Field required'] });
    expect(readValidation({ code: 'json_invalid', detail: 'The body is not JSON' })).toMatchObject({ valid: false, refused: true, errors: ['The body is not JSON'] });
    expect(readValidation(undefined)).toMatchObject({ valid: false, refused: true });
  });

  it('reads the 422 of an invalid document as the verdict it carries beside its diagnostics', () => {
    const body = {
      type: 't', title: 'invalid_pricing', status: 422, code: 'invalid_pricing', detail: 'The pricing document is invalid',
      valid: false, version: '0.2.0-draft.1', digest: 'sha256-x', syntax_version: '3.0', plans: ['BASIC'], add_ons: [],
      errors: ['plans.PRO: unknown limit'], warnings: [],
      diagnostics: [{ code: 'invalid_field', message: 'plans.PRO: unknown limit', pointer: '/plans/PRO/usageLimits/x' }],
    };
    expect(readValidation(body)).toMatchObject({ valid: false, refused: false, errors: ['plans.PRO: unknown limit'], plans: ['BASIC'], version: '0.2.0-draft.1' });
    expect(readValidation({ ...body, errors: [] })).toMatchObject({ valid: false, refused: false, errors: ['plans.PRO: unknown limit'] });
  });

  it('words the failures of pricing administration', () => {
    const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });
    expect(describePricingFailure(refusal(403, 'insufficient_api_key_permission'), 'x').title).toBe('This key can’t administer pricing (403)');
    expect(describePricingFailure(refusal(502, 'pricing_digest_mismatch'), 'x').title).toBe('The content doesn’t match its fingerprint (502 · pricing_digest_mismatch)');
    expect(describePricingFailure(refusal(502, 'pricing_control_plane_error'), 'x').title).toBe('The pricing control plane returned an error (502 · pricing_control_plane_error)');
    expect(describePricingFailure(refusal(409, 'already_deployed', 'It is deployed.'), 'x').title).toBe('The gateway refused the change (409 · already_deployed)');
    expect(describePricingFailure(refusal(422, 'invalid_version', 'Bad version.'), 'x').text).toBe('Bad version.');
  });
});

describe('pricingModel · the life of a version', () => {
  const available = (release: typeof LIVE_RELEASE) => lifecycleOf(release).filter((action) => action.available).map((action) => action.id);

  it('lets a private draft be deployed as a preview or deleted, but not made LIVE', () => {
    expect(available(DRAFT_RELEASE)).toEqual(['deploy', 'delete']);
  });

  it('lets nothing be done to the LIVE version but what keeps it live', () => {
    expect(available(LIVE_RELEASE)).toEqual([]);
  });

  it('lets a draining release be archived or made LIVE again, and states what the gateway checks itself', () => {
    expect(available(DRAINING_RELEASE)).toEqual(['activate', 'archive']);
    const archive = lifecycleOf(DRAINING_RELEASE).find((action) => action.id === 'archive')!;
    expect(archive.prerequisites.find((item) => item.server)?.label).toBe('No contract is still on it');
  });

  it('lets a deployed public release be drained or made LIVE', () => {
    const release = { ...LIVE_RELEASE, is_live: false };
    expect(available(release)).toEqual(['activate', 'drain', 'archive']);
  });
});
