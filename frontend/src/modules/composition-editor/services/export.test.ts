import { describe, expect, it } from 'vitest';
import { yamlFileName } from './export';

describe('yamlFileName', () => {
  it('names the file after the document’s composition and version', () => {
    expect(yamlFileName('composition: order-desk\nversion: 1.2.0\n')).toBe('order-desk-1.2.0.yaml');
  });

  it('falls back to composition.yaml, and keeps the name to safe characters', () => {
    expect(yamlFileName('kind: application\n')).toBe('composition.yaml');
    expect(yamlFileName('composition: "a b/c"\n')).toBe('a-b-c.yaml');
  });
});
