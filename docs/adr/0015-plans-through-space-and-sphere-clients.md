Status: PROPOSED for owner review (2026-10-22, revised the same day: plans topology)

# ADR-0015: Plans through SPACE and SPHERE with their real clients

- Status: Proposed; supersedes ADR-0010 except its "nothing is charged" rule
- Date: 2026-10-22
- Deciders: owner

## Context

ADR-0010 delegated plans to a remote SPACE but put it on hold (zero calls) and read the pricing from SPHERE through
a home-made client with a private API key. The first real attempt failed because SPACE rejected the pricing's
`createdAt` format (`docs/DEMO.md`). The group has since published the connected model: a pricing is designed and
versioned in SPHERE, SPACE links its service to SPHERE's permanent link, synchronizes versions, migrates contracts
and notifies host applications, which adapt without redeploying (ICSOC 2026 demo; TomatoMeter is the reference host
application). Official clients exist for every side: `space-python-client` (already used by the gateway),
`space-react-client`, and the group's `pricing-renderer` for Pricing2Yaml.

## Decision

1. OpenBinding's pricing lives in SPHERE; SPACE's `openbinding` service is linked to its permanent link with the
   `all_last` policy; the pricing is changed only in SPHERE.
2. The gateway's `plans` module is the only code that talks to SPACE, through `space-python-client`; it holds the
   entitlement map, verifies it against the active pricing, relays SPACE events and reverts evaluations of failed
   operations.
3. The gateway reads SPHERE only through its public permanent-link API (no key) to serve the pricing to the browser.
4. The browser uses `space-react-client` in token-only mode with the pricing token issued by the gateway, and renders
   pricings with `pricing-renderer`.
5. Topology (owner decision of 2026-10-22, INTENT D5). Every environment reads the pricing from SPHERE at
   `sphere.score.us.es` (permanent link `https://sphere.score.us.es/p/6ab0a323697330667ccce891`). Until
   `space.score.us.es` runs the latest SPACE release (1.7.1 today), each stack runs its own pinned SPACE of that
   release, whose `openbinding` service is created from that permanent link (`source: sphere`, `all_last`) by a
   bootstrap. Switching to `space.score.us.es` is a change of configuration. Unit and CI tests use a recorded
   pricing and never reach SPACE or SPHERE.
6. Nothing is charged: no checkout, credits or invoices. SPACE tracks the one usage limit that the pricing declares
   as renewable (solver hours per month, INTENT D4); the gateway compares the other limits with its own counts.
7. Removed: `sphere_client.py`, `pricing_catalog.py`, the deprecated `/v1/pricing` proxy and `/v1/pricing/catalog`,
   admin pricing validation, `space_client/deployments.py` and the release sweeps.

## Consequences

- The lab requirement "No local SPACE" becomes "no SPACE or SPHERE logic in OpenBinding; a pinned SPACE image is
  allowed in the lab and the previews"; `tests/test_no_local_space.py` is narrowed accordingly.
- No local SPHERE: the stacks need outbound HTTPS to `sphere.score.us.es`, and SPHERE's public API must stay
  reachable for SPACE's synchronization (SPACE keeps its last applied version while SPHERE is down).
- `space-react-client` 0.3.3 declares React ^18.3.1; a spike validates React 19 in token-only mode, and any fix goes
  upstream.
- Client and image upgrades are changes with contract tests (constitution Article 16).

## Evidence

`docs/ARCHITECTURE.md` §9, `ROADMAP.md` M4, `openbinding-gateway/src/openbinding_gateway/space_client/space.py`,
TomatoMeter `icsoc2026-demo` (`docker/lab/`), npm `space-react-client`, `pricing-renderer`; PyPI `space-python-client`;
SPACE 1.7.1 `docs/sphere-synchronization.md` (service creation from a permanent link, policies, five-minute
synchronization); SPHERE public API `GET /api/v1/public/pricings/{pricingId}`.
