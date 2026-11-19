import { describe, expect, it } from 'vitest';
import { labFeedKey } from '../../e2e/live/feedKey';

// The live walks derive the lab's feed key as tools/seed_lab.py does (`feed_key_for`): held to the fixed vector of
// openbinding-gateway/tools/tests/test_seed_lab.py.

describe('the lab feed key of the live walks', () => {
  it('is the seed’s key for the same password and environment', () => {
    expect(labFeedKey('synthetic-lab-password-1', 'lab-main', 'tomatometer', 'production')).toBe(
      'obe_d99385bd_03249980caea333a4ea61ff76c91fd581521f8015d72f89341f8c067'
    );
  });

  it('differs with the password and with the environment', () => {
    const key = labFeedKey('synthetic-lab-password-1', 'lab-main', 'tomatometer', 'production');
    expect(labFeedKey('another-password-1', 'lab-main', 'tomatometer', 'production')).not.toBe(key);
    expect(labFeedKey('synthetic-lab-password-1', 'lab-main', 'tomatometer', 'staging')).not.toBe(
      key
    );
  });
});
