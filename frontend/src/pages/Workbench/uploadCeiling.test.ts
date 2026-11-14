import { describe, expect, it } from 'vitest';
import { usageOf } from '../../test/fixtures/resources';
import { GATEWAY_BLOB_LIMIT, uploadCeiling } from './uploadCeiling';

describe('uploadCeiling', () => {
  it('uses the plan’s per-request ceiling from the usage', () => {
    expect(uploadCeiling(usageOf({ capabilities: { maxPayloadBytes: 8 * 1024 * 1024 } }), null, 'BASIC')).toEqual({ plan: 8_388_608, effective: 8_388_608, clamped: false });
  });

  it('never goes above what the gateway takes, and says the plan allows more', () => {
    const ceiling = uploadCeiling(usageOf({ capabilities: { maxPayloadBytes: 2 * GATEWAY_BLOB_LIMIT } }), null, 'PRO');
    expect(ceiling).toEqual({ plan: 2 * GATEWAY_BLOB_LIMIT, effective: GATEWAY_BLOB_LIMIT, clamped: true });
  });

  it('reads the pricing document when the usage has no ceiling', () => {
    const catalog = { plans: { BASIC: { usageLimits: { maxPayloadBytes: { value: 4_194_304 } } } } };
    expect(uploadCeiling(usageOf({ plan: 'BASIC', capabilities: {} }), catalog, undefined).effective).toBe(4_194_304);
  });

  it('is the gateway’s own limit when the plan’s is not known', () => {
    expect(uploadCeiling(null, null, undefined)).toEqual({ plan: null, effective: GATEWAY_BLOB_LIMIT, clamped: false });
  });
});
