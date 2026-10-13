import { describe, expect, it } from 'vitest';
import { personInitials } from './initials';

describe('personInitials', () => {
  it('uses the first letter of the first two tokens', () => {
    expect(personInitials('lab-owner')).toBe('LO');
    expect(personInitials('lab-viewer')).toBe('LV');
    expect(personInitials('lab-orgadmin')).toBe('LO');
    expect(personInitials('lab-member')).toBe('LM');
    expect(personInitials('first_last.third')).toBe('FL');
  });

  it('keeps the behaviour for names with spaces', () => {
    expect(personInitials('Ada Lovelace')).toBe('AL');
    expect(personInitials('  ada   king lovelace ')).toBe('AK');
  });

  it('takes the first two letters of a single token', () => {
    expect(personInitials('ada')).toBe('AD');
    expect(personInitials('x')).toBe('X');
  });

  it('uses only the local part of an email', () => {
    expect(personInitials('lab-owner@example.org')).toBe('LO');
    expect(personInitials('ada@example.org')).toBe('AD');
  });

  it('is empty when there is nothing to derive', () => {
    expect(personInitials('')).toBe('');
    expect(personInitials(undefined)).toBe('');
    expect(personInitials('--')).toBe('');
  });
});
