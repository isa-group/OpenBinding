import { describe, expect, it } from 'vitest';
import { LIMIT_ORDER } from '../../utils/limits';
import { catalogFixture } from './pricingFixture';
import { currentSelectionOf, readCatalog, withInfiniteLimits } from './pricingModel';

const view = readCatalog(catalogFixture)!;
const row = (id: string) => view.groups.flatMap((group) => group.rows).find((item) => item.id === id)!;

/** The published document has no add-ons; two synthetic ones show how the screen reads them. */
const withAddOns = {
  ...catalogFixture,
  addOns: {
    STORAGE_PACK: {
      description: 'Adds 5 GB of repository storage.', availableFor: ['LAB'], unit: 'pack/month',
      subscriptionConstraints: { minQuantity: 1, maxQuantity: 20 }, usageLimitsExtensions: { maxRepositoryStorage: { value: 5000 } },
    },
    ENGINE_PACK: {
      description: 'Lets one more federated engine run problems.', availableFor: ['FREE'], unit: 'pack/account',
      subscriptionConstraints: { minQuantity: 1, maxQuantity: 1 }, features: { apiAccess: { value: true } },
    },
  },
};

describe('the catalog fixture', () => {
  it('is pricing 0.2.0, whose plans all carry every limit and every limit the interface names', () => {
    const fixture = catalogFixture as { plans: Record<string, { usageLimits: Record<string, unknown> }>; usageLimits: Record<string, unknown> };
    const limitIds = Object.keys(fixture.usageLimits);

    expect(Object.keys(fixture.plans)).toEqual(['FREE', 'RESEARCH', 'LAB']);
    expect(LIMIT_ORDER.every((id) => limitIds.includes(id))).toBe(true);
    for (const [plan, definition] of Object.entries(fixture.plans)) {
      expect(Object.keys(definition.usageLimits), plan).toEqual(limitIds);
    }
  });
});

describe('readCatalog', () => {
  it('reads the plans in the order of the document, with no price anywhere', () => {
    expect(view.plans.map((plan) => [plan.id, plan.priceLabel, plan.unitLabel])).toEqual([
      ['FREE', 'Free', 'default plan'],
      ['RESEARCH', 'Free', 'with verified CAS'],
      ['LAB', 'Contact us', 'institutional agreement'],
    ]);
    expect(view.plans[2].description).toBe('By agreement, for groups that run benchmark campaigns or operate engines. Campaign-scale solver time, concurrency and generation');
    expect(view.plans[0].byAgreement).toBe(false);
    expect(view.plans[2].byAgreement).toBe(true);
  });

  it('turns any numeric price into an agreement instead of showing it', () => {
    const priced = readCatalog({ ...catalogFixture, plans: { PAID: { description: 'x', price: 19.99 } } })!;
    expect(priced.plans[0]).toMatchObject({ priceLabel: 'Contact us', byAgreement: true });
    expect(JSON.stringify(priced)).not.toContain('19.99');
  });

  it('groups features by the tags of the document and limits by what they measure', () => {
    expect(view.groups.map((group) => group.title)).toEqual([
      'Repository', 'Laboratory', 'Engines', 'Collaboration', 'Monthly', 'Capacity', 'Per request',
    ]);
    expect(view.groups.find((group) => group.title === 'Laboratory')?.note).toBe('Features');
    expect(view.groups.find((group) => group.title === 'Engines')?.note).toBe('Feature');
    expect(view.groups.find((group) => group.title === 'Monthly')?.rows.map((item) => item.name)).toEqual(['Solver hours', 'Generated instances']);
    expect(view.groups.find((group) => group.title === 'Capacity')?.rows.map((item) => item.name)).toEqual([
      'Problems', 'Repository storage', 'Concurrent runs', 'Federated engines', 'API keys',
    ]);
    expect(view.groups.find((group) => group.title === 'Per request')?.rows.map((item) => item.name)).toEqual([
      'Max collections', 'Max time per run', 'Cells per study run', 'Max instances per generation', 'Max private projects',
    ]);
  });

  it('shows what each plan gets for a feature: included, not included, or only with an add-on', () => {
    expect(row('runs').cells.map((cell) => cell.kind)).toEqual(['yes', 'yes', 'yes']);
    expect(row('apiAccess').name).toBe('API access');
    expect(row('federatedEngines').name).toBe('Federated engines');

    const without = readCatalog({
      ...withAddOns,
      plans: { ...catalogFixture.plans as object, FREE: { features: { apiAccess: { value: false }, studies: { value: false } } } },
    })!;
    const cells = (id: string) => without.groups.flatMap((group) => group.rows).find((item) => item.id === id)!.cells.map((cell) => cell.kind);
    expect(cells('apiAccess')).toEqual(['addon', 'yes', 'yes']);
    expect(cells('studies')).toEqual(['no', 'yes', 'yes']);
  });

  it('words the limits, keeping the exact value under the rounded one', () => {
    expect(row('maxRunMinutes').cells).toEqual([
      { kind: 'value', text: '5 min', exact: '5 min' },
      { kind: 'value', text: '30 min', exact: '30 min' },
      { kind: 'value', text: '24 h', exact: '1,440 min' },
    ]);
    expect(row('maxApiKeys').cells.map((cell) => (cell.kind === 'value' ? cell.text : cell.kind))).toEqual(['2', '10', '200']);
    expect(row('maxProblems').cells.map((cell) => (cell.kind === 'value' ? cell.text : cell.kind))).toEqual(['25', 'Unlimited', 'Unlimited']);
    expect(row('maxRepositoryStorage').cells[0]).toEqual({ kind: 'value', text: '500 MB', exact: '500 MB' });
    expect(row('solverHours').cells[2]).toEqual({ kind: 'value', text: '10,000 h', exact: '10,000 h' });
  });

  it('says which features a limit applies to', () => {
    expect(row('maxConcurrentRuns').appliesTo).toEqual(['Runs', 'Studies', 'Generator', 'Federated engines']);
    expect(row('maxRepositoryStorage').appliesTo).toEqual(['Repository']);
  });

  it('derives what must have room before something starts from the expressions of the document', () => {
    expect(view.gates).toEqual([
      { starts: 'a run', needs: ['Solver hours left this month'] },
      { starts: 'a study run', needs: ['Solver hours left this month'] },
      { starts: 'a generation', needs: ['Generated instances left this month'] },
    ]);
  });

  it('describes the add-ons: who can have them and in what quantity', () => {
    expect(view.addOns).toEqual([]);
    const offered = readCatalog(withAddOns)!;
    expect(offered.addOns.map((addOn) => addOn.id)).toEqual(['STORAGE_PACK', 'ENGINE_PACK']);
    expect(offered.addOns[0]).toMatchObject({ initial: 'S', effect: 'Adds 5 GB of repository storage', plans: ['LAB'], quantity: '1–20 packs', per: 'month' });
    expect(offered.addOns[1]).toMatchObject({ plans: ['FREE'], quantity: '1 per pack', per: 'account' });
  });

  it('calls a pre-1.0 pricing a development copy, and reads the release facts', () => {
    expect(view).toMatchObject({ version: '0.2.0', createdAt: '2026-10-22', currency: 'EUR', periods: 'monthly periods', developmentCopy: true });
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
    const pricing = withInfiniteLimits({ plans: { LAB: { usageLimits: { maxApiKeys: { value: null } } } }, custom: null }) as {
      plans: { LAB: { usageLimits: { maxApiKeys: { value: number } } } };
      custom: null;
    };
    expect(pricing.plans.LAB.usageLimits.maxApiKeys.value).toBe(Number.POSITIVE_INFINITY);
    expect(pricing.custom).toBeNull();
  });
});

describe('currentSelectionOf', () => {
  const claim = (plan: string, addOns: Record<string, number>, service = 'openbinding') => ({
    contractedServices: { [service]: '0.2.0' },
    subscriptionPlans: { [service]: plan },
    subscriptionAddOns: { [service]: addOns },
  });

  it('marks nothing for a visitor who is not signed in', () => {
    expect(currentSelectionOf(null, claim('LAB', { STORAGE_PACK: 2 }), 'openbinding')).toBeUndefined();
  });

  it('marks the plan of the profile when the token carries no subscription', () => {
    expect(currentSelectionOf('FREE', null, 'openbinding')).toEqual({ planId: 'FREE' });
  });

  it('adds the contracted add-ons of the token when it names the same plan', () => {
    expect(currentSelectionOf('LAB', claim('LAB', { STORAGE_PACK: 2, ENGINE_PACK: 0 }), 'openbinding')).toEqual({
      planId: 'LAB',
      addOns: { STORAGE_PACK: { selected: true, quantity: 2 } },
    });
  });

  it('keeps to the plan of the profile when the token names another plan or another service', () => {
    expect(currentSelectionOf('RESEARCH', claim('LAB', { STORAGE_PACK: 2 }), 'openbinding')).toEqual({ planId: 'RESEARCH' });
    expect(currentSelectionOf('LAB', claim('LAB', { STORAGE_PACK: 2 }, 'another'), 'openbinding')).toEqual({ planId: 'LAB' });
  });
});
