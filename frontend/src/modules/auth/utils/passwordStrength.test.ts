import { describe, expect, it } from 'vitest';
import { passwordStrength } from './passwordStrength';

describe('passwordStrength', () => {
  it('grades by length first and variety second', () => {
    expect(passwordStrength('')).toEqual({ level: 0, label: 'Not set' });
    expect(passwordStrength('ninechars')).toEqual({ level: 1, label: 'Too short' });
    expect(passwordStrength('tencharsok')).toEqual({ level: 2, label: 'Good' });
    expect(passwordStrength('lowercaseonlylonger')).toEqual({ level: 2, label: 'Good' });
    expect(passwordStrength('Mixed-Case-1234')).toEqual({ level: 3, label: 'Strong' });
  });
});
