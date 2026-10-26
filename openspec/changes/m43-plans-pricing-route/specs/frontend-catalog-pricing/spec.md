## REMOVED Requirements

### Requirement: Read-only pricing source
**Reason**: It is a gateway obligation on `GET /v1/pricing/current` and the other `/v1/pricing` routes, which this change retires (ADR-0015 §7), and it requires serving "the configured published version" (`SPACE_PRICING_VERSION`) where ADR-0015 §1 and §3 make the latest public SPHERE version, read without a key, the one shown. Its id `req~frontend-catalog-pricing-read-only-source~1` is not reused.

**Migration**: Replaced in capability `plans-pricing` by `req~plans-pricing-sphere-public-read~1` (only GET requests, no credential), `req~plans-pricing-descriptor~1` (the latest public version), `req~plans-pricing-integrity~1` and `req~plans-pricing-sphere-unavailable~1` (`503` `pricing_unavailable`). The frontend reads `GET /v1/plans/pricing` instead of `GET /v1/pricing/current` and `GET /v1/pricing/catalog` before slice S4 removes them; the unavailable state of the Pricing page stays a frontend requirement of the frontend lead.
