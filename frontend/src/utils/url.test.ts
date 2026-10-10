import { describe, expect, it } from 'vitest';
import { safeExternalHref } from './url';

describe('safeExternalHref', () => {
  it('lets web addresses through as they were written', () => {
    expect(safeExternalHref('https://sphere.example/pricing/0.1.0')).toBe('https://sphere.example/pricing/0.1.0');
    expect(safeExternalHref('  http://localhost:8080/x ')).toBe('http://localhost:8080/x');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/x',
    '/app/account',
    'sphere.example/pricing',
    '',
  ])('refuses %j', (address) => {
    expect(safeExternalHref(address)).toBeUndefined();
  });

  it('refuses what is not text', () => {
    expect(safeExternalHref(null)).toBeUndefined();
    expect(safeExternalHref(undefined)).toBeUndefined();
    expect(safeExternalHref(42)).toBeUndefined();
  });
});
