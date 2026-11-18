import type { PlansPricingView, PricingDocument } from '../../modules/core/api/account';
import plansPricing from './core/plans-pricing.json' with { type: 'json' };

/**
 * OpenBinding's published pricing 0.2.0 as `GET /v1/plans/pricing` answers it: written by the gateway itself from the recorded
 * SPHERE version (`openbinding-gateway/tools/dump_frontend_fixtures.py`, `core/plans-pricing.json`), so the unit and browser
 * tests that stand in for the API read what the gateway serves. The gateway enforces the same ids (`utils/limits.ts` names the
 * ones the interface reads).
 */
export const PLANS_PRICING_FIXTURE = plansPricing as unknown as PlansPricingView;

/** Its parsed document (`.inf` as `null`), what the plan model and the plan ceilings read. */
export const catalogFixture: PricingDocument = PLANS_PRICING_FIXTURE.document;
