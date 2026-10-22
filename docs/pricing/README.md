Status: PROPOSED for owner review (2026-10-22). INTENT decision D9.

# OpenBinding pricing

This folder holds OpenBinding's pricing proposals and the reasons behind them. The published versions live in SPHERE
under the permanent link `https://sphere.score.us.es/p/6ab0a323697330667ccce891`. Only the owner publishes there
(constitution 16.2). SPACE operates whatever is published (ADR-0015).

| File | What |
|---|---|
| [`openbinding-0.2.0.yml`](openbinding-0.2.0.yml) | the proposal: Pricing2Yaml 3.1, the result of the cycle below |

Summary:

| | 0.1.5 (in SPHERE since 2026-09-23) | 0.2.0 (proposed) |
|---|---|---|
| Plans | BASIC (0), ADVANCED (contact us), RESEARCH (0, US CAS), PRO (contact us) | FREE (0), RESEARCH (0, US CAS), LAB (contact us) |
| Add-ons | 6, all "contact us" | none |
| Features | 11 | 7 |
| Usage limits | 19, 4 of them renewable | 7, 1 renewable (solver hours per month) |
| Configuration space | 50 subscriptions | 3 subscriptions |

## 1. Method

The cycle follows the SaaS pricification process of García-Fernández et al. [1]. The process has three stages:

1. Identify the features, their dependencies and the essential ones.
2. Define the structure:
   - key and common features;
   - usage limits that turn common features into key ones;
   - plans or add-ons;
   - the distribution heuristic and subscription consistency.
3. Set prices with a strategy, after checking the operational expenditure (OpEx) of a fully-utilizing user of each
   plan.

The process has two roles. The domain expert is the owner. The pricing manager reviews each stage. We suggest one of
the group's SPHERE/SPACE authors for that role.

The cycle also applies INTENT principle 12: what no journey of INTENT §2 needs does not enter the pricing.

## 2. What the cycle found in 0.1.5

1. **The tier order is broken.** RESEARCH (free) includes everything ADVANCED (contact us) includes, plus
   institutional branding, and has higher limits on every count. The pricing page therefore shows a paid plan that a
   free one dominates.
2. **Add-ons have no purchase path.** Six "contact us" add-ons raise the configuration space from 4 to 50, but
   OpenBinding has no checkout (INTENT §8). Raising a limit by agreement is the same as assigning a larger plan.
3. **Some features belong to retired areas** (ADR-0020):
   - `advancedAnalytics` belongs to the decision-space workspace;
   - `reproducibilityArchive` and `jobHistoryDays` are retention, which is a platform rule (ARCHITECTURE §10);
   - `institutionalBranding` serves no journey.
4. **Some limits are counted across sponsored organization subtrees.** These are `organizations`, `members`,
   `projects`, `privateProjects`, `collections`, `studies` and `storageBytes`. Sponsorship retires (INTENT D3).
5. **Technical safety ceilings are presented as plan limits.** These are `maxIterations`, `maxPayloadBytes` and
   `maxInstanceComplexityLog10`. Users do not choose a plan for them; they protect the platform.
6. **Four renewable counters are metered locally** (`taskStarts`, `federatedTaskStarts`, `solverSeconds`,
   `studyRuns`). Solver time alone captures the cost driver (INTENT D4).
7. **Several features are essential, so they are not levers.** `authoring`, `publishing` and `reproducibleExport`
   are in every plan and never differentiate one.

## 3. Stage 1: features

| Feature | Pillar and journey | Essential | Depends on |
|---|---|---|---|
| `repository`: author, version and publish problems and collections; permanent links, citations, Verify | P1; journeys 1, 2 | yes | — |
| `runs`: run problem versions on the built-in engines | P2, P3; journey 2 | yes | `repository` |
| `studies`: compare engines over problems or a collection; protocol metrics; published results | P2; journey 3 | yes | `runs`, `repository` |
| `generator`: solver-aware generation of collections | P2; curators | no | `runs` |
| `federatedEngines`: register remote engines that pass conformance | P3; journey 4 | yes, with a limit | `runs` |
| `collaboration`: organizations, projects, members, roles; public or private projects | E1; journey 6 | yes | — |
| `apiAccess`: API keys for scripts, QACOBench and MCP clients | E1; journey 6 | yes | — |

Some things stay outside the pricing, because no plan gates them:

- reading and verifying public content, which needs no account (journey 1);
- submitting a language extension, which an administrator reviews (journey 5).

The 0.1.5 features end as follows:

- `authoring` merges into `repository`;
- `solve` becomes `runs`;
- `publishing` and `reproducibleExport` become part of `repository` and `studies`;
- `advancedAnalytics`, `reproducibilityArchive` and `institutionalBranding` go.

## 4. Stage 2: structure

**Plans, not add-ons.** Every segment shares the essential features, so the process calls for plans, three or four
of them. The segments are:

- any researcher;
- Universidad de Sevilla members, identified by CAS;
- groups that run benchmark campaigns or operate engines, by agreement.

Add-ons are rejected, because nothing can be bought and every add-on would have to add a key feature that a plan
does not already give.

**Key features.**

- `generator` is the one non-essential feature. It is valuable to curators and costs compute.
- The other key features are essential features turned key by their usage limits:

| Limit | Makes key | FREE | RESEARCH | LAB | Why these values |
|---|---|---|---|---|---|
| `solverHours` (renewable, per month) | `runs`, `studies`, `generator` | 5 | 100 | 1,000 | FREE: about 300 one-minute runs. RESEARCH: the whole QACOBench 1.1.1 reference campaign (46,350 executions × 5 s ≈ 64 h of budget) fits in a month, in study runs of at most 5,000 cells. LAB: several campaigns a month |
| `maxRunMinutes` | `runs`, `studies` | 5 | 30 | 120 | interactive runs; exact solvers on research instances; large exact runs |
| `maxConcurrentRuns` | all execution | 1 | 4 | 8 | fair sharing: on a 16-core host, one LAB account uses at most half |
| `maxStudyCells` (per study run) | `studies` | 500 | 5,000 | 50,000 | a small collection × 3 engines; a QACOBench suite; the whole reference campaign as one study run |
| `maxFederatedEngines` | `federatedEngines` | 1 | 3 | 10 | an author tries one engine; a group maintains a few; a lab hosts a portfolio |
| `maxPrivateProjects` | `collaboration` | 1 | 10 | 50 | public by default (open science); private work before a paper |
| `maxApiKeys` | `apiAccess` | 2 | 10 | 50 | one script and one MCP client; a group's automation; campaign infrastructure |

**Distribution heuristic.** FREE ⊂ RESEARCH ⊂ LAB:

- RESEARCH adds `generator` and raises every limit;
- LAB raises every limit and adds no feature.

The process accepts raised limits on key features as added value. Inventing a LAB-only feature that no journey needs
would break principle 12.

**Consistency.** With plans only, every subscription is exactly one plan. Every plan defines every feature and limit.
Every limit is linked to a declared feature. Every expression reads only declared features and limits. The file parses
with `pricing4ts` 0.12.1, the library SPACE 1.7.1 uses (3 plans, 0 add-ons, 7 features, 7 limits).

**Moved out of the pricing.** These rules are the same for every account:

- **Technical ceilings** become gateway settings, using today's RESEARCH values: 128 MiB per package, 1,000,000
  iterations per run, binding spaces up to 10^20 for exact engines.
- **Run history** follows the retention rules of ARCHITECTURE §10.
- **Organizations, members, projects and collections** are not limited. A research platform should not throttle
  colleagues working together.

## 5. Stage 3: prices

- **Strategy.** FREE uses penetration pricing (price 0): adoption by researchers is the goal. RESEARCH is
  institutional (price 0): Universidad de Sevilla runs the platform, and CAS proves eligibility. LAB is set by
  agreement and should cover at least the OpEx of a fully-utilizing LAB account. Nothing is charged inside OpenBinding
  (INTENT §8). Demand-driven pricing needs data on perceived value that does not exist yet; we revisit after a year of
  SPACE usage data (accounts per plan, hours used against allowance).
- **OpEx of a fully-utilizing account.** This is an account that spends all its solver hours every month:
  OpEx ≈ `solverHours` × *c*, where *c* is the cost of one core-hour on the production host. Storage and the gateway's
  re-evaluation are small next to solver time. *c* is not known yet. For *c* between €0.01 and €0.05 per core-hour
  (dedicated cloud cores), the monthly OpEx is:
  - FREE: €0.05–0.25;
  - RESEARCH: €1–5;
  - LAB: €10–50.

  The owner replaces *c* with the real cost of the production server.
- **Capacity check.** A host with *K* cores offers about 730 × *K* core-hours a month. At a 60 % target load, a
  16-core host offers ≈ 7,000 h. The allowances of active accounts should stay below that. In particular, LAB is
  assigned to at most *K*/8 accounts at a time, or its concurrency is lowered.
- **Annual discount.** The process recommends monthly prices plus a discounted annual price. That does not apply,
  because nothing is charged. `billing` keeps `monthly: 1` only.

## 6. How OpenBinding enforces it (input for `ROADMAP.md` M4.2)

Feature ids in SPACE are `openbinding-<feature>`; limit ids are `openbinding-<limit>`.

| Operation | Feature evaluated | Checked by the gateway | Consumption sent to SPACE |
|---|---|---|---|
| seal a problem or collection version; publish | `repository` | — | — |
| start a run on a built-in engine | `runs` | budget ≤ `maxRunMinutes`; running runs < `maxConcurrentRuns` | `solverHours` = budget in hours |
| start a run on a federated engine | `federatedEngines` | running runs < `maxConcurrentRuns` | — |
| create a study run | `studies` | cells ≤ `maxStudyCells`; each cell's budget ≤ `maxRunMinutes` | — |
| start a study cell on a built-in engine | `studies` | running runs < `maxConcurrentRuns` | `solverHours` = budget in hours |
| generate with the solver-aware option | `generator` | running runs < `maxConcurrentRuns` | `solverHours` = budget in hours |
| register a federated engine | `federatedEngines` | registered < `maxFederatedEngines` | — |
| make a project private | `collaboration` | private projects of the owner's organizations < `maxPrivateProjects` | — |
| create an API key | `apiAccess` | active keys < `maxApiKeys` | — |

SPACE admits an evaluation while the month's hours are not exhausted, then adds the consumption. One run can
therefore end a month slightly over the allowance. That is accepted: the count stays exact and predictable.

## 7. From 0.1.5 to 0.2.0 in SPACE

With the `all_last` policy, SPACE moves every contract to the latest public version. Each subscription goes as
follows:

- It keeps its plan if a plan with the same name exists: RESEARCH stays RESEARCH.
- Otherwise it takes the cheapest public plan with a numeric price. FREE and RESEARCH tie at 0; the tie is resolved
  by plan id, so BASIC, ADVANCED and PRO fall back to FREE.

No limit name of 0.1.5 is reused with a different type, tracking or period, so the migration cannot block. No
contract exists today: SPACE has been on hold, with zero calls.

## 8. Publishing (owner)

1. In SPHERE, open the OpenBinding pricing of the `openbinding` organization and add a version from
   `openbinding-0.2.0.yml`. Keep it public.
2. Check that the public manifest lists it as the latest version:
   `curl -s https://sphere.score.us.es/api/v1/public/pricings/6ab0a323697330667ccce891` (field `latestVersionId`,
   version `0.2.0`).
3. Any SPACE linked to the permanent link picks it up within its synchronization cycle.

## References

[1] A. García-Fernández, S. Laso, J. A. Parejo, J. Berrocal, A. Ruiz-Cortés, J. M. Murillo. *Towards Effective
SaaS Pricing Design: A Case Study of CCSIM.* ICSOC 2024 Workshops, LNCS 15833, pp. 157–168. Springer, 2026.
https://doi.org/10.1007/978-981-96-7238-7_13

[2] SPACE 1.7.1, `docs/sphere-synchronization.md`: service creation from a SPHERE permanent link, synchronization
policies and contract migration.
