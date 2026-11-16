# SPHERE → OpenBinding platform inventory

This inventory is the implementation boundary for the collaborative-platform
branch. It was refreshed on 2026-09-05 against SPHERE, SPHERE docs, SPACE and
OpenBinding. It records what is reused, adapted, redesigned or deliberately
excluded so a later implementation choice is traceable rather than accidental.

## Reference state

- SPHERE source: `356ad1129acaee4beb3c4574e389f158cb0a2eaa` for this 2026-09-05 inventory. The code F1 and F2
  reuse from SPHERE follows `73779a8af260adb4c7de981bd479327d7b82f97a` (see "Compositions after SPHERE's pricings"
  below and `THIRD_PARTY_NOTICES.md`).
- SPHERE docs: `107c5451e464e77a87a1f8b72dd71fa9d9e93231`.
- SPACE: `5fa4d3fd990be9477e742917f829853a1791f798`.
- space-python-client: `1ec3bce6c57fb3f7192e3d721048fa738e921ade`.
- Open SPHERE pull requests (rechecked through the GitHub API on 2026-09-05):
  #139 bulk permission drafts, #140 password recovery, #141 password change,
  #142 account deletion/cascade, #143 linter templates and #144 changelog
  workflow permissions.
- No open pull requests were present in SPHERE docs, SPACE or OpenBinding.

The PR list is queried again immediately before integration because it is a
moving input. Features are adapted from their contracts and tests, never
blindly copied from an unmerged branch.

## Product and architecture decisions

| SPHERE capability | Decision | OpenBinding interpretation |
|---|---|---|
| Public shell and dashboards | Adapt | A binding observatory centred on projects, cases, studies, engines and reproducible activity |
| Organizations and teams | Extend | Arbitrarily nested organizations, inherited roles and invitations |
| Pricings and immutable versions | Adapt (revised) | Immutable BIM/case revisions in the user platform. Pricing lifecycle: not in OpenBinding; it lives in the remote SPHERE/SPACE consoles and is read-only here (see below) |
| Public/private resources | Adapt | Project, case and artifact visibility |
| Collections | Exclude | Removed in F0a: a study selects its case revisions directly |
| Configuration-space analysis | Redesign | Feasibility, Pareto, convergence, objectives, runtime, stability and cross-engine comparison |
| HARVEY assistant | Exclude/replace | Deterministic diagnostic actions and documentation links; no LLM dependency or fabricated result |
| API keys and entity permissions | Extend | Closed capabilities plus optional method, organization, project, resource slug and exact-engine reductions |
| Account recovery/change/delete | Include | Single-use recovery, authenticated change and safe cascade/revocation workflows |
| Linter templates | Include | BIM/qos-binding and pricing templates validated by the same schemas as execution |
| Changelog automation | Adapt | Platform, BIM/Engines and Documentation streams generated from releases and Conventional Commits |
| Team, Research and Funding pages | Adapt | Verified people, publications, grants, projects and reproducibility links stored as reviewed Git data |
| MongoDB | Exclude | PostgreSQL remains the only operational source of truth |
| Local YAML storage | Limit | Fixtures and portable packages only (`space/pricing/openbinding.yml`); never the live operational pricing |
| Public file URLs | Harden | File downloads with ETag/immutable cache for public items and `private, no-store` for authenticated assets |
| Direct database administration | Constrain | Local-only Adminer profile plus audited safe maintenance endpoints |
| Simulated payment | Exclude | `Contact us / Institutional agreement`; no checkout or fictitious transactions |

## Binding-specific extrapolations

SPHERE's pricing comparison becomes a **study**: a reproducible Cartesian
product of case revisions, exact engine revisions, parameter sets and seeds.
Every cell freezes its inputs, can be retried independently and contributes to
aggregate analysis only after its canonical result is reevaluated by
OpenBinding. A study selects its case revisions directly.

SPHERE's version catalogue becomes the provenance spine for BIM resources:
revisions are immutable and content-addressed, mutable aliases are short-lived,
and runs and studies pin exact BIM, dialect, engine, dataset and parameter
digests. This preserves the existing package → validation → dialect/profile →
IR → engine → reevaluation pipeline instead of wrapping it in a second solver.

## External pricing boundary

> **Status update.** The table above and the reference state are the
> 2026-09-05 inventory and are kept as a record of what was decided then. The
> boundary below is the current one; where the two differ, this section wins.

SPHERE and SPACE are **remote** services (`https://space.score.us.es` for SPACE;
`SPHERE_URL` for SPHERE) administered in their native consoles. OpenBinding does
not host them, edit their pricing, publish releases or renew contracts itself:

- It *shows* the account's plan, permissions and links to the consoles.
- It *reads* the published pricing read-only from SPHERE under the single
  organization `OpenBinding`, slug `openbinding`, server-to-server with
  `x-api-key` (`sphere_client.py`, `pricing_catalog.py`).
- It *delegates* account creation and plan changes to the official SPACE client
  with a `MANAGEMENT`-scoped key (`space_client/space.py`).
- It persists release metadata, digests and the `LIVE` pointer, never the YAML.

There is no local SPACE stack and no pricing administration console in
OpenBinding. Local files under `space/` hold only the pricing fixture used by
tests and development.

**Development scope.** The development pricing is **private** and the
development service is a different service from the production one, but both sit
inside the *same organizations*. A shared organization does not isolate
credentials, so a development key is high-risk (see the README).

**Code that predates this decision.** The earlier pricing-release workflow is
gone from the gateway: there is no `SpaceDeploymentClient`, no
`space_client/deployments.py`, no admin pricing route and no `pricing:admin`
API-key permission, and the deprecated YAML proxy `GET /v1/pricing` was removed.
`routes/pricing.py` serves only `GET /v1/pricing/catalog` and
`GET /v1/pricing/current`, which the public Pricing page reads.

SPHERE's static-file route does not authenticate the content URL even when a
version is private in its catalogue. “Private” therefore means catalogue and
workflow privacy until the upstream static delivery is cryptographically
protected; drafts must not contain secrets.

## Compositions after SPHERE's pricings (F1, F2)

Since the redesign around compositions, a **composition** is OpenBinding's analogue of a SPHERE pricing, and its
versions of a pricing's versions, at SPHERE revision `73779a8a`. What was taken, and how, is decided in
[ADR 0050](adr/0050-frontend-layers-and-sphere-reuse.md) and listed in `THIRD_PARTY_NOTICES.md`:

| SPHERE | OpenBinding |
|---|---|
| PricingDiff and `forkPricing` | the composition diff (`composition/diff.py`) and fork (`modules/compositions/application/fork.py`), ported |
| `text-diff.ts`, `requested-version.ts` | copied verbatim into `frontend/src/shared/sphere/` |
| `change-summary.ts`, `pricing-fragment.ts`, `new-version-menu`, `use-version-changes` | adapted copies (binding, values and offering sections; the `#composition=` fragment) |
| the pricing card, versions, version diff, analytics, fork modal, problems panel and configuration-space screens | guided rewrites on OpenBinding's components ("no code copied") |
| the private read rule (`privateReadRule.ts`) and public pricings | public compositions, with one not-found answer for anything a caller cannot read ([ADR 0047](adr/0047-public-compositions.md)) |
| `version-order.ts`, the private-access fallback, the vendored renderer, `VariablesEditor` | not copied |

The row "Public/private resources" above now reads: compositions are private or public; problems, runs and studies
are their organization's only.

## Third-party FaaS pricings

`pricings/{aws,azure,gcloud}` are Pricing2Yaml documents of AWS Lambda, Azure
Functions and Google Cloud Run functions. They are third-party offerings that BIM
experiments analyse to derive candidate costs (`pricings/README.md`); they are
not OpenBinding plans and have nothing to do with the SPHERE/SPACE pricing above.
