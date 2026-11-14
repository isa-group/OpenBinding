import type { PricingCatalog, UsageView } from '../../api/auth';
import { planLimit } from '../Project/projectModel';

/** What the gateway never lets one upload exceed, whatever the plan says (`_payload_limit` in `routes/artifacts.py`). */
export const GATEWAY_BLOB_LIMIT = 512 * 1024 * 1024;

export interface UploadCeiling {
  /** The plan’s `maxPayloadBytes`, when it is known. */
  plan: number | null;
  /** What one upload may really be. */
  effective: number;
  /** The plan allows more than the gateway takes. */
  clamped: boolean;
}

export function uploadCeiling(usage: UsageView | null | undefined, catalog: PricingCatalog | null | undefined, plan: string | undefined): UploadCeiling {
  const fromUsage = usage?.capabilities?.maxPayloadBytes;
  const planValue = typeof fromUsage === 'number' && Number.isFinite(fromUsage) ? fromUsage : planLimit(catalog, usage?.plan ?? plan, 'maxPayloadBytes');
  const effective = planValue === null ? GATEWAY_BLOB_LIMIT : Math.min(planValue, GATEWAY_BLOB_LIMIT);
  return { plan: planValue, effective, clamped: planValue !== null && planValue > GATEWAY_BLOB_LIMIT };
}
