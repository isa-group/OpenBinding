# 0058. Proposals and their executor

- Status: accepted
- Date: 2026-11-21 (F6-B; plan decision 11 "cambios manuales que confirma una persona", plan §8)

## Context

Decision 11 lets OpenBinding notice and explain an upstream change ([ADR 0057](0057-upstream-watches-and-events.md))
but never act on it by itself. The person who decides still needs a short way from an event to a fix: derive a
version from a re-solved problem and adopt it where it matters, in one confirmation, knowing exactly what will happen.
Plan §8 asks for that write model to be the one ORBIT (F7) reuses: whatever makes the request, a form today or an
assistant tomorrow, only proposes; a person confirms; the change is applied step by step, re-checked, reported exactly
and audited. SPHERE's ORBIT already does this for pricings (`OrbitPlanService`, `OrbitPlanRepository`,
`OrbitExecutorService`), so OpenBinding ports its plan model and executor rather than designing another.

## Decision

**A proposal is an organization's typed steps** (`proposals`, `proposal_steps`). It names a composition when every
step targets one (always in F6; the column is nullable so F7 can propose a problem revision with none), an origin
(`web`; F7 adds `mcp` and `chat`), a scope (`composition:<id>` on the web; F7's `conversation:<id>`), its author, a
summary and warnings written by the server, an optional typed phrase, and optionally the upstream event it answers
(always one of its own composition: a composite foreign key, and a CHECK for the NULL a composite key skips). Members
read every proposal of their organization; only its author confirms or cancels it. Statuses are SPHERE's lower-cased
plus `stale`: `pending → executing | cancelled | superseded | stale`, `executing → completed | partial | failed`, every
other state terminal, under a state-machine trigger; what a proposal proposes never changes.

**Steps are built in code.** A request names steps by kind; each kind (a registry in `domain/proposals.py`) validates
its parameters, computes its base and writes its description. F6 registers two:

| Kind | Base (stored at creation) | Apply |
|---|---|---|
| `seal_derived` | the head version and the digest of the exact document derived for the person to see, whose bytes are stored as the step's `preview` (diffed on read against the version in effect, by the function behind `POST /v1/compositions/diff`) | `derive.derive_and_seal(..., expect_digest=)`, the derive route's own sequence |
| `adopt` | the environment's ETag and the version in effect | `adoption.adopt(..., if_match=, source='proposal', proposal_id=)`, the one adopt path |

The web asks for `adopt` or `derive_and_adopt` (`seal_derived` + `adopt` of `@s1.version`). **References** let a
step take an earlier step's declared output (`@s<n>.<output>`): the builder records the dependency, the step stores
only the parts of its base known now and lists the rest as `deferred`, and the parts are checked when the step runs (a
mismatch fails it, `derivation_changed`). F7's chains (`apply_sphere_recipe` → `seal_derived` of `@s1.revision` →
`adopt` of `@s2.version`) need no new mechanism: a test-only kind exercises it. A **destructive** kind goes alone and
carries a typed phrase (SPHERE's `normalizePhrase`); F6 registers none, and a test-only kind exercises the rule. The
registry is the one list of kinds: the database does not repeat it, so F7 adds a kind without a schema change.

**The §8 invariants, in code** (P1–P9):

- P1: steps and descriptions come from the server; nothing a client sends is executed as text; the watcher creates no
  proposal.
- P2: a new proposal supersedes its author's pending one in the same scope; a partial unique index keeps one pending,
  and the create that loses that race retries the supersession once.
- P3: a destructive step goes alone, behind its phrase (422 `confirmation_required` / `confirmation_mismatch`).
- P4: each step's outcome is stored as it ends, a refusal as the writer's own answer; a step whose dependency did not
  complete is `skipped`; independent steps still run; `completed`, `partial` or `failed`; never retried, never rolled
  back.
- P5: confirm first checks every stored base, deriving each seal step again; anything that moved makes the proposal
  `stale` and answers 409 `proposal_stale` with each reason, and nothing changes. Between steps, each step's own
  precondition holds (`adopt`'s `If-Match`).
- P6: permissions are checked again with the confirming caller: each step's role, and for a personal API key each
  step's own permission (`compositions:adopt` for an adoption), checked by the executor because the route table is
  keyed by path.
- P7: only the author confirms or cancels (403 `proposal_not_yours`); a non-member gets the 404 parity.
- P8: the claim is one conditional UPDATE (ORBIT's `claimForExecution`): two confirmations run it once.
- P9: an adoption records `source` (`direct` or `proposal`) and the proposal that made it.

**The executor** (`proposal_executor.confirm`) is `OrbitExecutorService.execute` with those checks in front: read,
phrase, permissions, pre-flight, claim, then the steps in order, each applied and committed by its writer and its
outcome written at once with the proposal's progress stamp (`progressed_at`), the proposal's status read again before
each step. Confirmation answers synchronous JSON; an `on_step` hook lets F7 stream the same run.

**Interrupted runs** are closed by the upstream watcher's housekeeping, as SPHERE's `closeInterrupted(id, staleBefore)`
judges `updatedAt`: an `executing` proposal with no progress for `PROPOSAL_EXECUTION_DEADLINE_S` (600) has its `adopt`
steps reconciled from `composition_adoptions.proposal_id`, the step that was running marked `failed` ("check whether
it was applied"), later ones `skipped`, and ends as the executor would: `completed` when every step is done, else
`partial` or `failed`. Every write is conditional, so the closure and
a late outcome never both land. With the cancellation of a deleted account's pending proposals (below) these are the
only writes of the watcher that are not its own state, and they only end what a person started.

**Locks** follow the delete paths' order: a composition, then its proposals, then their steps. Creating a proposal
share-locks its composition first; the executor writes a step's outcome after its proposal's stamp; deleting a
composition, an organization or an account's personal organization locks proposals before steps. Deleting an
environment share-locks its composition before the environment's row and makes the pending proposals that adopt in it
`stale`, skipping one another transaction holds (`SKIP LOCKED`; the pre-flight finds the environment missing anyway);
deleting an account cancels its pending proposals in other organizations before its memberships go, skipping one
another transaction holds (waiting could close a cycle with another account's deletion, which holds its personal
organization's proposals), and deletes its personal organization's with it. What it skips, or a proposal its author's
other session makes meanwhile, the upstream watcher's housekeeping cancels once the deletion has committed: every
`pending` proposal of a deleted account, audited as its author's.

**Keys.** A proposal's own routes and the caller's list name no composition, so the key's boundary is checked against
the proposal's composition there; at confirm each step's own key permission is checked, and a run the key may not see
is refused rather than read as gone.

**Nothing moves a feed but an adoption.** Making, superseding, cancelling or finding a proposal stale writes no
environment; a `completed` proposal changes a feed once, through `adoption.adopt()`.

## Consequences

- F7 adds kinds (with their outputs, bases and pre-flight) and origins, and reuses `proposals.create`, `get`, `cancel`
  and `proposal_executor.confirm` unchanged; the organization-level routes already serve a proposal without a
  composition.
- A multi-step proposal is not one transaction (a seal and an adoption each commit by themselves): a failure after a
  committed step is reported as `partial`, step by step, rather than undone.
- A step that depends on an earlier one cannot show its document before confirmation; it is shown as decided when that
  step has run, and checked when it runs.
- A pre-flight derives each seal step again: confirming costs one evaluation per seal step, as deriving does.
