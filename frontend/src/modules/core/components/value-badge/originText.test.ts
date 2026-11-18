import { describe, expect, it } from 'vitest';
import type { ProblemFacts, ValueSource } from '../../api/types';
import tomatometer from '../../../../test/fixtures/core/tomatometer-email.facts.json';
import { originText, sourceLink, sourceText } from './originText';

const facts = tomatometer as ProblemFacts;
const candidate = (id: string) => facts.candidates.find(entry => entry.id === id)!;
const mailgun = candidate('email.mailgun.foundation');
const sendgrid = candidate('email.sendgrid.pro');
const source = (value: ValueSource | null | undefined): ValueSource => value!;

describe('originText', () => {
  it('keeps the package words of a value no import wrote', () => {
    expect(
      originText({ kind: 'package', resource: 'catalog', path: 'candidates.json', pointer: '/x' })
    ).toBe('written in candidates.json at /x');
  });

  it('says a priced value’s plan, version and value, then where it is written', () => {
    expect(originText(mailgun.origins.subscription, '35 USD/month')).toBe(
      'Priced from SPHERE: danruilop1/mailgun FOUNDATION, version 2026-10 (35 USD/month); written in sphere-email.json at /spec/candidates/email.mailgun.foundation/features/subscription'
    );
  });

  it('says which guarantee a value maps, and links its terms', () => {
    const guarantee = source(mailgun.origins.availability.source);
    expect(sourceText(guarantee)).toBe(
      'From the guarantee guaranteedUptimeSla (yes → 0.9995) of danruilop1/mailgun FOUNDATION, version 2026-10'
    );
    expect(sourceLink(guarantee)).toBe('https://www.mailgun.com/legal/terms/');
    expect(sourceLink(source(mailgun.origins.subscription.source))).toBeNull();
  });

  it('says a usage limit with its period, and an unlimited one in words', () => {
    expect(sourceText(source(mailgun.propertyOrigins.emailsPerMonth.source))).toBe(
      'Usage limit emailsPerMonth: 50,000 email per month, of danruilop1/mailgun FOUNDATION, version 2026-10'
    );
    expect(sourceText(source(mailgun.propertyOrigins.emailsPerDay.source))).toBe(
      'Usage limit emailsPerDay: unlimited, of danruilop1/mailgun FOUNDATION, version 2026-10'
    );
  });

  it('says a value set by hand, and an assumed limit with its reason', () => {
    expect(sourceText(source(sendgrid.origins.latency.source))).toBe(
      'Set by hand when importing from SPHERE'
    );
    expect(sourceText(source(sendgrid.propertyOrigins.emailsPerDay.source))).toBe(
      'Assumed unlimited for emailsPerDay when importing from SPHERE: the pricing does not declare it'
    );
  });

  it('says a feature and a carried value', () => {
    const feature: ValueSource = {
      kind: 'feature',
      carried: true,
      detail: { name: 'twoFactorAuthentication', raw: true },
      pricing: source(mailgun.origins.subscription.source).pricing,
    };
    expect(sourceText(feature)).toBe(
      'Feature twoFactorAuthentication: yes, of danruilop1/mailgun FOUNDATION, version 2026-10 (kept from an earlier version)'
    );
  });

  it('never writes an id, a hash or a snapshot', () => {
    for (const entry of facts.candidates) {
      for (const origin of [
        ...Object.values(entry.origins),
        ...Object.values(entry.propertyOrigins),
      ]) {
        const text = originText(origin, '1');
        expect(text).not.toMatch(/[0-9a-f]{24}/);
        expect(text).not.toMatch(/0000-4000/);
      }
    }
  });
});
