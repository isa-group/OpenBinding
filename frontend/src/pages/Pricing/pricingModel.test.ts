import { describe, expect, it } from 'vitest';
import { retrievePricingFromYaml } from 'pricing4ts';
import source from '../../../../space/pricing/openbinding.yml?raw';
import { catalogFixture } from './pricingFixture';
import { readCatalog, withInfiniteLimits } from './pricingModel';

const view = readCatalog(catalogFixture)!;
const row = (id: string) => view.groups.flatMap((group) => group.rows).find((item) => item.id === id)!;

describe('the catalog fixture', () => {
  it('stands for the pricing document it is named after', () => {
    const real = retrievePricingFromYaml(source) as unknown as {
      plans: Record<string, { usageLimits: Record<string, { value?: unknown }> }>;
      features: Record<string, unknown>;
      addOns: Record<string, unknown>;
    };
    const fixture = catalogFixture as { plans: typeof real.plans; features: object; addOns: object };

    expect(Object.keys(fixture.plans)).toEqual(Object.keys(real.plans));
    expect(Object.keys(fixture.features)).toEqual(Object.keys(real.features));
    expect(Object.keys(fixture.addOns)).toEqual(Object.keys(real.addOns));
    for (const [plan, definition] of Object.entries(fixture.plans)) {
      for (const [id, { value }] of Object.entries(definition.usageLimits)) {
        const actual = real.plans[plan].usageLimits[id]?.value;
        // `.inf` has no JSON form: the gateway sends null. And pricing4ts reads anything above 100,000,000 as
        // "unlimited" and clamps it there, so it is the lower of the two that has to agree.
        const same = value === null
          ? actual === null || actual === undefined || (typeof actual === 'number' && actual >= 100_000_000)
          : actual === Math.min(Number(value), 100_000_000);
        expect(same, `${plan}.${id}`).toBe(true);
      }
    }
  });
});

describe('readCatalog', () => {
  it('reads the plans in the order of the document, with no price anywhere', () => {
    expect(view.plans.map((plan) => [plan.id, plan.priceLabel, plan.unitLabel])).toEqual([
      ['BASIC', 'Free', 'default plan'],
      ['ADVANCED', 'Contact us', 'institutional agreement'],
      ['RESEARCH', 'Free', 'with verified CAS'],
      ['PRO', 'Contact us', 'institutional agreement'],
    ]);
    expect(view.plans[1].description).toBe('Advanced analytics and larger capacity');
    expect(view.plans[0].byAgreement).toBe(false);
    expect(view.plans[3].byAgreement).toBe(true);
  });

  it('turns any numeric price into an agreement instead of showing it', () => {
    const priced = readCatalog({ ...catalogFixture, plans: { PAID: { description: 'x', price: 19.99 } } })!;
    expect(priced.plans[0]).toMatchObject({ priceLabel: 'Contact us', byAgreement: true });
    expect(JSON.stringify(priced)).not.toContain('19.99');
  });

  it('groups features by the tags of the document and limits by what they measure', () => {
    expect(view.groups.map((group) => group.title)).toEqual([
      'Authoring', 'Solving', 'Analysis', 'Collaboration', 'Federation', 'Reproducibility', 'Institutional',
      'Monthly', 'Capacity', 'Per request', 'Sponsored',
    ]);
    expect(view.groups.find((group) => group.title === 'Analysis')?.note).toBe('Features');
    expect(view.groups.find((group) => group.title === 'Solving')?.note).toBe('Feature');
    expect(view.groups.find((group) => group.title === 'Monthly')?.rows.map((item) => item.name)).toEqual([
      'Capacity units', 'Solves', 'Solver time', 'Federated solves', 'Study runs',
    ]);
  });

  it('shows what each plan gets for a feature: included, not included, or only with an add-on', () => {
    expect(row('advancedAnalytics').cells.map((cell) => cell.kind)).toEqual(['no', 'yes', 'yes', 'yes']);
    expect(row('reproducibilityArchive').cells.map((cell) => cell.kind)).toEqual(['no', 'addon', 'no', 'yes']);
    expect(row('institutionalBranding').cells.map((cell) => cell.kind)).toEqual(['no', 'no', 'yes', 'no']);
    expect(row('institutionalBranding').name).toBe('Institutional identity');
    expect(row('apiAccess').name).toBe('API access');
  });

  it('words the limits, keeping the exact value under the rounded one', () => {
    expect(row('solverSeconds').cells).toEqual([
      { kind: 'value', text: '15 min', exact: '900 s' },
      { kind: 'value', text: '5 h', exact: '18,000 s' },
      { kind: 'value', text: '8.3 h', exact: '30,000 s' },
      { kind: 'value', text: '50 h', exact: '180,000 s' },
    ]);
    expect(row('taskStarts').cells.map((cell) => (cell.kind === 'value' ? cell.text : cell.kind))).toEqual(['10', '25', '50', 'Unlimited']);
    expect(row('maxInstanceComplexityLog10').cells.map((cell) => (cell.kind === 'value' ? cell.text : cell.kind))).toEqual(['10⁹', '10¹⁵', '10²⁰', 'Unlimited']);
    expect(row('storageBytes').cells[2]).toEqual({ kind: 'value', text: '5 GiB', exact: '5,368,709,120 bytes' });
  });

  it('says which features a limit applies to', () => {
    expect(row('concurrentJobs').appliesTo).toEqual(['Solve', 'Federated engines', 'Studies']);
    expect(row('maxPayloadBytes').appliesTo).toEqual(['Authoring', 'Solve']);
  });

  it('derives what must have room before something starts from the expressions of the document', () => {
    expect(view.gates).toEqual([
      { starts: 'a solve', needs: ['Solves left this month', 'A free job slot'] },
      { starts: 'a federated solve', needs: ['Federated solves left this month', 'A free job slot'] },
      { starts: 'a study run', needs: ['Study runs left this month'] },
    ]);
  });

  it('describes the add-ons: who can have them and in what quantity', () => {
    expect(view.addOns.map((addOn) => addOn.id)).toEqual([
      'COMPUTE_PACK', 'COLLABORATION_PACK', 'STORAGE_PACK', 'FEDERATION_PACK', 'CONCURRENCY_PACK', 'REPRODUCIBILITY_ARCHIVE',
    ]);
    expect(view.addOns[0]).toMatchObject({ initial: 'C', plans: ['ADVANCED', 'PRO'], quantity: '1–10 packs', per: 'month' });
    expect(view.addOns[5]).toMatchObject({ plans: ['ADVANCED'], quantity: '1 per account', per: 'account' });
  });

  it('calls a pre-1.0 pricing a development copy, and reads the release facts', () => {
    expect(view).toMatchObject({ version: '0.1.0', createdAt: '2026-09-01', currency: 'EUR', periods: 'monthly periods', developmentCopy: true });
    expect(readCatalog({ ...catalogFixture, version: '1.2.0' })?.developmentCopy).toBe(false);
  });

  it('reads a limit that no table knows by its type, so the pricing can grow without a code change', () => {
    const grown = readCatalog({
      ...catalogFixture,
      usageLimits: {
        ...(catalogFixture.usageLimits as object),
        exportMinutes: { description: 'Export time.', type: 'RENEWABLE', unit: 'second/month', defaultValue: 120, linkedFeatures: [] },
      },
    })!;
    const added = grown.groups.find((group) => group.title === 'Monthly')?.rows.find((item) => item.id === 'exportMinutes');
    expect(added?.name).toBe('Export minutes');
    expect(added?.cells[0]).toEqual({ kind: 'value', text: '2 min', exact: '120 s' });
  });

  it('is not a pricing without plans', () => {
    expect(readCatalog({})).toBeNull();
    expect(readCatalog({ plans: {} })).toBeNull();
  });
});

describe('helpers', () => {
  it('gives the renderer the number an unlimited allowance stands for', () => {
    const pricing = withInfiniteLimits({ plans: { PRO: { usageLimits: { taskStarts: { value: null } } } }, custom: null }) as {
      plans: { PRO: { usageLimits: { taskStarts: { value: number } } } };
      custom: null;
    };
    expect(pricing.plans.PRO.usageLimits.taskStarts.value).toBe(Number.POSITIVE_INFINITY);
    expect(pricing.custom).toBeNull();
  });
});
