// The plan's client: the account's usage, the published pricing, and the pricing token the SPACE
// client reads, cut out of the old `api/client.ts` monolith.

import {
  PRICING_TOKEN_KEY,
  PRICING_TOKEN_UPDATED_EVENT,
  apiClient,
  HttpTransport,
} from '../../core/api/http';
import type { PlansPricingView, UsageView } from '../../core/api/account';

/** The client over a transport: the application's own, or a test's. */
export function planClientOf(transport: HttpTransport) {
  const planClient = {
    async getOwnUsage(): Promise<UsageView> {
      return transport.request<UsageView>('/v1/users/me/usage');
    },

    /**
     * The published pricing: its version label, the YAML and the parsed document, read by the gateway from
     * SPHERE and verified.
     *
     * Fetched rather than bundled, so the plans page cannot drift from the
     * document SPACE was actually given. Public: a pricing nobody can read
     * before signing up is not much of a pricing.
     */
    async getPlansPricing(): Promise<PlansPricingView> {
      return transport.request<PlansPricingView>('/v1/plans/pricing');
    },

    /** What the interface gates features with; the browser never sees SPACE. */
    async getPricingToken(): Promise<string> {
      const body = await transport.request<{ pricing_token: string }>('/v1/users/me/pricing-token');
      localStorage.setItem(PRICING_TOKEN_KEY, body.pricing_token);
      window.dispatchEvent(
        new CustomEvent(PRICING_TOKEN_UPDATED_EVENT, { detail: body.pricing_token })
      );
      return body.pricing_token;
    },
  };
  return planClient;
}

export const planClient = planClientOf(apiClient);
