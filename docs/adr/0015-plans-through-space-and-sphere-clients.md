Status: PROPOSED for owner review (2026-10-22)

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
5. The lab and previews run pinned public SPHERE and SPACE images, linked by a bootstrap like the TomatoMeter lab;
   tests and previews never use the production deployments.
6. Nothing is charged: no checkout, credits or invoices. SPACE may track usage limits that the pricing declares.
7. Removed: `sphere_client.py`, `pricing_catalog.py`, the deprecated `/v1/pricing` proxy and `/v1/pricing/catalog`,
   admin pricing validation, `space_client/deployments.py` and the release sweeps.

## Consequences

- The lab requirement "No local SPACE" becomes "no SPACE or SPHERE logic in OpenBinding; pinned SPHERE/SPACE images
  are allowed in the lab".
- `space-react-client` 0.3.3 declares React ^18.3.1; a spike validates React 19 in token-only mode, and any fix goes
  upstream.
- Client and image upgrades are changes with contract tests (constitution Article 16).

## Evidence

`docs/ARCHITECTURE.md` §9, `ROADMAP.md` M4, `openbinding-gateway/src/openbinding_gateway/space_client/space.py`,
TomatoMeter `icsoc2026-demo` (`docker/lab/`), npm `space-react-client`, `pricing-renderer`; PyPI `space-python-client`.
