import { describe, expect, it } from 'vitest';
import type { SphereImportRecipe } from '../../api/sphereApi';
import email from '../../../../test/fixtures/sphere/recipe.tomatometer-email.json';
import storage from '../../../../test/fixtures/sphere/recipe.storage.json';
import {
  demandProblems,
  emptyForm,
  fromRecipe,
  providerKey,
  readSpec,
  slugOf,
  toRecipe,
  writeSpec,
} from './recipe';

const emailRecipe = email.recipe as unknown as SphereImportRecipe;
const storageRecipe = storage.recipe as unknown as SphereImportRecipe;

describe('the SPHERE recipe form', () => {
  it.each([
    ['the TomatoMeter e-mail recipe', emailRecipe],
    ['the storage recipe', storageRecipe],
  ])('reads %s back and writes it unchanged', (_, recipe) => {
    expect(toRecipe(fromRecipe(recipe))).toEqual(recipe);
  });

  it('keeps per-source aliases, assumed limits, seats and billing', () => {
    const form = fromRecipe(emailRecipe);
    const sendgrid = form.sources.find(source => source.provider === 'sendgrid')!;
    expect(sendgrid.assume).toEqual({ emailsPerDay: 'unlimited' });
    expect(form.sources.find(source => source.provider === 'resend')!.names).toEqual({
      emailsPerDay: 'transactionalEmailsPerDay',
      emailsPerMonth: 'transactionalEmailsPerMonth',
      guaranteedUptimeSla: 'uptimeSla',
    });
    expect(fromRecipe(storageRecipe).sources[0].seats).toBe(1);
    const billed = { ...form, sources: [{ ...sendgrid, billing: 'annual' }] };
    expect(toRecipe(billed).tasks[0].from[0]).toMatchObject({
      provider: 'sendgrid',
      billing: 'annual',
    });
  });

  it('reads and writes each kind of property, the per-provider values by hand included', () => {
    const availability = readSpec(emailRecipe.tasks[0].properties!.availability);
    expect(availability).toMatchObject({
      kind: 'guarantee',
      name: 'guaranteedUptimeSla',
      map: { true: 0.9995, false: 0.99 },
      overrides: { postmark: { '*': 0.999 }, sendgrid: { '*': 0.999 } },
    });
    expect(writeSpec(availability)).toEqual(emailRecipe.tasks[0].properties!.availability);
    expect(readSpec('price').kind).toBe('price');
    expect(writeSpec(readSpec(42))).toBe(42);
    expect(
      writeSpec({ ...readSpec({ limit: 'emailsPerMonth' } as never), unlimitedAs: 1e6 })
    ).toEqual({
      limit: 'emailsPerMonth',
      unlimitedAs: 1e6,
    });
  });

  it('pins every version: the wizard never sends latest', () => {
    for (const task of toRecipe(fromRecipe(emailRecipe)).tasks)
      for (const source of task.from)
        if ('sphere' in source) expect(source.sphere.version).toMatch(/^[0-9a-f]{24}$/);
  });

  it('says what keeps the demand from being sent', () => {
    const form = {
      ...emptyForm(),
      demand: [
        { name: 'dailyEmails', value: 1000, unit: 'email/day' },
        { name: 'bad name', value: 5, unit: '' },
        { name: 'huge', value: 2e8, unit: '' },
      ],
      requireLimits: [{ limit: 'emailsPerDay', atLeast: 'nothing' }],
    };
    expect(demandProblems(form)).toEqual([
      'The demand “bad name” needs a name of letters, digits and _.',
      'The demand huge is above 1e+8, which counts as unlimited.',
      'The requirement on emailsPerDay names no demand or number.',
    ]);
    expect(demandProblems(fromRecipe(emailRecipe))).toEqual([]);
  });

  it('suggests a provider key and a problem slug from names', () => {
    expect(providerKey('Twilio SendGrid Email API')).toBe('twiliosendgridemailapi');
    expect(providerKey('Mailgun')).toBe('mailgun');
    expect(slugOf('Storage Plans')).toBe('storage-plans');
  });
});
