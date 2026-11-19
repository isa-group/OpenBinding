# 0054. Composition environments, adoption and the feed

- Status: accepted
- Date: 2026-11-19 (F4-A; plan §1 "Entorno", §4 `composition_environments`, `adopt`, the feed)

## Context

A composition becomes useful to a running application when the application can read, at a fixed address, which
version is in effect, and when that changes only because a person decided it. The plan calls the place an
**environment** (`composition_environments`) and the act **adopt**; it names a feed
(`…/environments/{env}/composition`) and an "API key bounded to the environment". It lists no adoption history and no
key table, and its words "environment" and "deployment" were already taken in OpenBinding's documents (the stages of
OpenBinding itself, and federated engine deployments).

## Decision

**An environment belongs to one composition** (`composition_environments`): a slug that never changes (it is part of
the feed's address), a name, a description, an **operator** (the member answerable for it; a member who leaves stays
named, marked so), an **adoption policy** (`adoptRole`, the weakest role that may adopt: ADMIN by default, MEMBER per
environment) and the **expected users** its margins assume. Composite foreign keys keep it within its composition's
organization and its version in effect within its composition. In the docs, "environment" means only this;
OpenBinding's own development, lab, preview and production are its **stages**.

**Adopting is the one write that changes what an application runs** (`POST …/environments/{environment}/adopt`). It
requires `If-Match` with the environment's entity-tag (428 `precondition_required` when absent or `*`: the wildcard
would let a stale view through, and this is the write that reaches a third party). The read phase is committed, then
the composition is locked `FOR KEY SHARE` (it conflicts with a composition delete) and the environment `FOR UPDATE`,
refreshed, so ETag, role and version in effect are read from the locked row; the claim is a conditional, monotonic
`UPDATE` (no row: 412), never an `IntegrityError`. The caller's role must reach `adoptRole`; personal API keys need
`compositions:adopt`, which `compositions:write` does not imply. An archived composition adopts nothing (its feeds
keep serving); the version in effect is not adopted again (409 `already_in_effect`), so every adoption moves the
feed; a linked version needs an evaluation by the installed toolchain whose binding holds (409 `evaluation_stale`,
`binding_invalid`, `evaluation_semantics_changed`). Nothing adopts automatically and nothing chains derive and
adopt: F6's proposal executor will call the same `adoption.adopt()`.

**Each adoption leaves an immutable history row** (`composition_adoptions`, numbered per environment) that **pins the
evaluation** the version was judged on and records the version's content digest. The current evaluation can change
without an adoption (a re-evaluation on a new toolchain reads the offering again), so an environment's margins read
the pinned one and move only with an adoption. Deriving the history from audit rows was rejected: audit rows are
free-form, unreferenced and cannot pin an evaluation. An adoption audits `composition.adopted` and tells the operator
and the composition's followers who hold a role, never the actor (`CompositionAdopted`: inbox on, e-mail off by
default).

**The feed serves the adopted version's sealed bytes, unchanged, with that version's content digest as a strong
`ETag`** (the version content route's tag). Its validator therefore names the bytes: seals, edits, re-evaluations,
newer offering or upstream versions, key changes, checks and margin reads never move it, every adoption does, and
A→B→A gives A's tag again. The composition's own ETag (`updated_at`) could not serve: every PATCH and seal bumps it.
`If-None-Match` naming the tag (or `*`) is 304; weak tags never match; who may read is decided first, so a refusal is
never a 304. `Cache-Control: private, no-cache`, `Vary: Authorization, X-API-Key`, and the informative
`OpenBinding-Adoption` and `OpenBinding-Composition-Version` headers. Nothing else is in the feed: margins,
evaluations and environment metadata would move it.

**The feed is read with an environment-owned feed key** (`obe_…`, `composition_environment_keys`): the entropy, SHA-256
storage and constant-time comparison of a personal key, a marker of its own, shown once, at most two live per
environment (rotation), revoked for good. Personal keys could not be used: they act as their person, die with the
account, count against `maxApiKeys` and cannot be bounded to one environment. SPACE's organization API keys are the
precedent. Only `get_feed_reader` resolves an `obe_` key; every other route that resolves a credential refuses it
with 401 `environment_key_elsewhere`, the stateless language and BIM routes answer it as nobody, and the log filter
redacts it beside `obk_`. A member may read the feed too, with a session or a personal key with `compositions:read`
(its boundary applies). A credential reads the feed at most `FEED_RATE_PER_MINUTE` (60) times a minute, counted in
Redis with the per-process fallback the authentication limiter has (429 `feed_rate_limited`).

**A composition with environments is not deleted** (409 `composition_in_operation`, naming them): an application may
be reading one. Deleting an organization deletes its environments' keys, adoptions and environments before the
versions and evaluations they reference. `check` (`POST …/environments/{environment}/check`) reports the version in
effect against what its sources publish now and writes nothing; classification, watches and events are F6's.

Pricing 0.2.0 has no environment limit, so `COMPOSITION_ENVIRONMENTS_MAX` (5 per composition) stands in until
`maxEnvironments` arrives with pricing 0.3.0.

## Consequences

- A running application configures one URL and one key, polls about every 30 seconds, keeps its last good state on
  any answer but 200 and 304, and switches provider only when a person adopts another version.
- F6 adds a `source`/`proposal_id` to adoptions and a "through a proposal" policy on `adoptRole`, not a second adopt
  path; its upstream badges count against `adopted_version_id`, and its "offering changed" margins compare the pinned
  evaluation with a new snapshot through the same `margins.compute()` ([ADR 0055](0055-margins-per-offering-plan.md)).
- F8 attaches SPACE links per environment to `composition_environments`.
