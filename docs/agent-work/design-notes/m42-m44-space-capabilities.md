# Design note: SPACE and SDK capabilities for M4.2 and M4.4

Source: owner design note `own-04f61cd82df344c4aa14025732de1ac6`. Context for planning M4.2 and M4.4; not work for
now.

All the PRs below are open against `develop`. Use them once merged and deployed to the SPACE that OpenBinding uses.
Each one announces a token in the `X-Space-Capabilities` header (SPACE #69), and the SDKs refuse a guarantee that the
server does not announce. The `plans` module can therefore check the token and degrade fail-closed.

| # | SPACE/SDK feature | PR | What it gives OpenBinding's `plans` module | ROADMAP slice |
|---|---|---|---|---|
| 1 | Solver hours at admission with revert on failure: the limit is part of the atomic increment; each consumption returns a `consumptionId`; `?revert=true&consumptionId=` reverts exactly that consumption once; 200 with `skipped` if a level no longer exists | SPACE #84 (atomic-usage-limits); python #12 (`features.revert_consumption`) | Consume solver hours at admission and revert them if the job fails. Store the `consumptionId` in the job so the revert can be made on failure. | M4.2 |
| 2 | Retries without duplicates: `Idempotency-Key` header | SPACE #85 (idempotency-key); python #12 | Send `Idempotency-Key` on consumptions, contract creation and novations, so a retry does not duplicate them. Same model as `docs/IDEMPOTENCY.md`. | M4.2 |
| 3 | Event relay: contract events, `eventId` (UUIDv7), `occurredAt`, at-most-once delivery; dedupe and resync warnings in the client | SPACE #77 (contract events) and #83 (eventId, occurredAt, delivery); python #10 and #11 | Invalidate cached capabilities when a contract changes in the SPACE console. | M4.2 (event relay) |
| 4 | Pricing version: SPACE says which version applies to a new contract | SPACE #73 (new-contracts-version); python #8 | `SPACE_PRICING_VERSION` is no longer needed. It caused failed contracts when plans were renamed (see the comment in `create_contract`). | M4.2 |
| 5 | Plan change: `If-Match` / `expectedContractVersion` with 412; preview of a change without writing; `keepBillingPeriod` does not reset renewal | SPACE #70 (If-Match), #75 (preview), #71 (keepBillingPeriod); python #9 | Replace today's `change_plan`, which reads add-ons and then novates, with a guarded change. Preview a change without writing it. Keep the billing period on a plan change. | M4.2 |
| 6 | Least privilege: the subscription is in the pricing token; an EVALUATION key is enough for the read path | SPACE #76 (subscription in the pricing token), #88 (EVALUATION key) | `caps` needs no contract read (today it takes two calls). An EVALUATION key suffices for the read path; MANAGEMENT is needed only for the contract lifecycle. | M4.2 |
| 7 | No change for OpenBinding: the token `sub` becomes a URN and tokens are signed with ES256 (JWKS) | SPACE #80 and #87 | None. OpenBinding neither reads `sub` nor verifies the signature. In M4.4 (`space-react-client` in token-only mode) no browser verification is needed because the token comes from the backend. | M4.4 (no change) |
