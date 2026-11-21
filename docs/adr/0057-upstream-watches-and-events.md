# 0057. Upstream watches and events

- Status: accepted
- Date: 2026-11-21 (F6-A; plan decision 11 "Cambios upstream: detectar, clasificar, registrar y avisar")

## Context

A composition version pins the SPHERE pricings it binds (`binding.*.from`, or the value origins of its linked
revision) and names its own offering. Those pricings keep changing upstream: a price rises, a plan is retired, a
family is hidden, the offering's author publishes a new version. Decision 11 asks OpenBinding to notice, to say what
the change means for each version a team runs, and to tell the people who can act, while doing nothing automatic: no
re-evaluation, no new revision, no version, no adoption. The feed an application reads changes only when a person
adopts.

## Decision

**Watches and their references.** A `pricing_watches` row exists per watched source and read scope (`public`, a
registry, or an organization for private keyed reads and URL offerings), shared by every composition that reads it.
`seal_into` registers, for a new version only and from stored data only, an insert-only `pricing_watch_refs` row per
version × watch × subject × pinned version: `from` entries (through the snapshot the seal pre-phase took), bound
candidates without `from` (through the linked revision's value origins) and the offering. "Every live version that
pins pricing X" is then one indexed query; no cycle parses a document. A `from` without a stored snapshot gets an
unresolved ref, resolved later on its own back-off (`pricing_ref_attempts`).

**The watcher** is a second task of the gateway lifespan, beside the job reconciler; every replica starts it and one
works per cycle (`pg_try_advisory_xact_lock` on its own key). It claims due watches that a live version references
with a lease (`FOR UPDATE SKIP LOCKED`), staggered by a phase derived from each watch's id (SPACE's pattern), and asks
each manifest with `If-None-Match` and `revalidate=True` (past the adapter's cache and negative cache). Its schedule,
back-off and debounce are in the database: a 429 closes the watch's whole bucket until `Retry-After`; failures back
off exponentially to an hour; a family is gone only after two 404s from requests actually sent at least one interval
apart by the database clock (`not_found_since`, `gone_epoch`). A rejected organization key is `credential_missing`,
never an event; a removed registry alias is `registry_unknown`. A per-cycle read budget and classifier budget bound
the load; `/v1/admin/queues` shows the state.

**Live versions only.** A version is classified when it is its composition's latest or adopted somewhere. A
superseded, unadopted version keeps its past events and gets no new ones.

**Classification is one pure function** (`upstream_classify`) over two normalised snapshots, the bound selection, the
stored origins, the pinned recipe and the version's values: no solver, no `BimPort`, no clock. It uses one
implementation of each building block: pricing-renderer's `compareSelections` ported to Python (held to the renderer
by the parity test), the generator's own per-candidate judgement (`candidate_values`, moved out of the generator), and
`margins.compute`. The first rule that applies decides: `source_unavailable` > `pricing_unreadable` > rebinding
recommended (`plan_removed` with a `renamedTo` hint only for an identical twin, `plan_private`, `price_not_numeric`,
add-on reasons, `currency_changed`, `billing_missing`, `value_unmapped`, `requirement_unmet` for a required feature
lost or a required limit below the demand) = `binding_invalid` > `values_changed` > `no_impact`. A direct global delta
is given only for a priced origin feeding a `sum`/`selectedCandidate` feature with verified values; everything else
gets before and after (`no_direct_mapping`). Nothing is re-evaluated, and every event says so. An offering change is
`offering_changed`, never invalidating, with every adopted environment's margins and the latest version's before and
after. Goldens G1–G20 run offline.

**Events** (`composition_upstream_events`) are written once per key and never rewritten: one binding event per
(version, watch, old → new), one offering event per (composition, watch, new); a URL whose content returns to a hash
already named gets `sha256:<hex>~<n>`, since an offering is compared with what its last event observed. The partial
unique indexes are the idempotency across replicas (`ON CONFLICT DO NOTHING`). Only `state` (`open` → `reviewed` → `resolved`), the review
note and the stamps change, under a state-machine trigger. `no_impact` events are stored (they keep the watcher
idempotent) but neither told nor badged.

**Resolution only by a person's seal.** `seal_into` resolves, in the seal's transaction, every open or reviewed
binding event of the composition when the new version pins the event's new version or a newer one in a `from` of the
family (rule a), or links a revision whose origins read the family at that version or newer, whatever it bound (rule
b: re-solving on the new data resolves even when the result binds another provider). An event whose fix was sealed
before the watcher noticed is born resolved. The watcher's insert takes `FOR SHARE` on the composition row, which
conflicts with the seal's `FOR NO KEY UPDATE`, so the two never miss each other. Offering events end reviewed: the
offering is not pinned in the document. No route resolves an event.

**Badges are computed when read**, never stored, for members only: on the composition, its versions and its
environments (with "resolved in X, not adopted here"). The watcher never writes an environment or an adoption, so the
environment's ETag and the feed cannot move.

**Notifications** (`UpstreamEvent`, inbox on, e-mail off) go to the active members with MEMBER or a stronger role on
the composition's organization, inherited roles included, plus the operators of the environments where an affected
version is adopted, once per (composition, watch, new version), for told events only.

**What the watcher never does** (invariant W): create a run, a problem revision, a composition version, an evaluation,
an adoption or a proposal, or change an environment. It writes snapshots as a system read, watch state, late refs,
the attempts schedule, events and notifications. An import test asserts it cannot reach seal, derive, adoption or the
execution module.

## Consequences

- Detection takes at most one interval (300 s, at least 60 s in production; 20 s in the lab); each watch costs one
  conditional request per interval, and even a 304 makes SPHERE hash the family's versions.
- The "after" global value assumes nothing else changed; only a person's re-evaluation knows constraints and domains.
- The normaliser's 1e8 `Unlimited` sentinel can make two different large numbers compare equal (`unlimited_sentinel`).
- A version sealed before F6 has no refs (nothing is in production; labs are reset).
