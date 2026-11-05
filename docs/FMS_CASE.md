# The guiding case: a hybrid fleet management SaaS

OpenBinding Studio is developed against one guiding case, in two architectural versions:
the hybrid SaaS fleet management system (FMS) presented at JISBD 2025 and revised at
JISBD 2026. This document records what each version is, how version 1 maps onto the
package already in the corpus, and what is still undecided.

Why it matters beyond illustration: version 1 is already modelled as a BIM v1 package, so
it is the reference against which the Composition2Yaml translation is proved. The
translation is faithful when the composition written by hand compiles to a package whose
IR digest equals the existing one.

## Version 1 (JISBD 2025)

Six services, two of them in-house:

| id | service | nature |
| --- | --- | --- |
| S1 | routing | in-house, the orchestrator |
| S2 | classical solver | in-house |
| E1 | vehicle monitoring | external |
| E2 | quantum solver | external (IBM Quantum or Amazon Braket) |
| E3 | billing and payments | external |
| E4 | platform and infrastructure | external (PaaS/IaaS) |

The decision that makes the case interesting: **S1 calls either S2 or E2 depending on the
size of the problem**. A small routing problem goes to the in-house classical solver; a
large one goes to a quantum solver on the market. That is a probabilistic exclusive
choice, not a conditional one, which is why the Studio's editor models branches with
probabilities.

Its pricing lives in SPHERE under `faked/Fleet Management`: plans Starter and Advanced,
add-ons AddStop, AddRoute and AddVehicle, sixteen configurations.

### How version 1 maps onto the existing package

`examples/demo/13_fms` is this architecture. The mapping is not written down anywhere in
the package, so it is derived here from the candidates each task admits:

| package task | candidates | service |
| --- | --- | --- |
| `T1` | Google Cloud, AWS | **E4**, platform and infrastructure |
| `T2` | Radius IoT Network, Samsara Fleet API | **E1**, vehicle monitoring |
| `T3` | HERE Routing API, Distance Matrix API | distance and travel time |
| `T5` | Amazon Braket, IBM Quantum | **E2**, quantum solver |
| `T6` | PayPal, Stripe | **E3**, billing and payments |
| `node_classic_routing` | none, a `local` task | **S2**, in-house classical solver |

S1 is not a task: it is the composition itself, the orchestrator whose workflow the
package describes. The workflow is a sequence `T1 → T2 → T3 → (choice) → T6`, where the
choice is the exclusive between `node_classic_routing` (probability 0.8) and `T5`
(probability 0.2) — S1 routing a small problem in-house four times out of five.

Modelling S2 as a `local` task is what the package does and must be preserved -- the
phase F1 gate is digest equality -- and it is why Composition2Yaml needs a `local` kind and
not only open and fixed ones. It is worth being exact about what it asserts, though,
because "outside the candidate market" is not the same as "no information". A local task
contributes each property's neutral under *every* operator, and this one sits in an
exclusive aggregated with `weightedSum` at probability 0.8, so the package states that the
in-house classical path is free, instantaneous, perfectly available, perfectly reliable
and -- since the neutral of a `min` property over a bounded domain is its upper bound --
*maximally secure*, four times out of five. The recorded numbers are the proof: the cost
minimum is exactly `220 + 500 + 300 + (0.8 * 0 + 0.2 * 1200) + 950 = 2210`, and the
recorded security 4.0 comes from T2 because the exclusive node reads `0.8 * 5.0 + 0.2 * 5.0
= 5.0` and never binds the outer `min`. Any claim drawn from this package about classical
versus quantum cost, latency or security rests on that optimism. Section 4.1 of
`docs/COMPOSITION2YAML.md` says when to prefer a `fixed` task instead, and what it costs.

The package declares five properties: `cost` (USD/month), `execution_time` (ms),
`availability`, `reliability` and `security` (a 1 to 5 score). Their neutrals, all
inferred by the container from the sequence operator and the domain, are `0.0`, `0.0`,
`1.0`, `1.0` and **`5.0`** — the last one because `security` aggregates with `min` over a
real domain bounded at 5, so the value that does not constrain a minimum is the upper
bound. Getting that one wrong is the sharpest trap in the whole case.

A second trap sits next to it. All five properties aggregate their exclusive with
`weightedSum`, `availability` and `reliability` included, where `docs/FEATURES.md` gives
the canonical operator for those two as the routing-weighted product. So version 1 cannot
be written with the bare `availability` and `reliability` templates: both need an explicit
`aggregate: {exclusive: weightedSum}` override, or the composition compiles to a different
package. The two operators agree to six decimals at this package's own values, so the
mismatch would not show up as a wrong number -- only as a digest that does not match.

Its binding space has 32 bindings: five service tasks with two candidates each.

### Open question: the missing T4

The package has `T1`, `T2`, `T3`, `T5`, `T6` and no `T4`, with no comment explaining the
gap. Either a sixth task was dropped during authoring, or the numbering was kept aligned
with a figure in the paper. This needs a decision before the version 1 composition is
written by hand, because the Composition2Yaml source will reproduce the task ids exactly
and an unexplained gap in a hand-written document invites someone to "fix" it — which
would change the digest.

Equally open: `T3` is distance and travel time, which is not one of S1, S2 or E1 to E4.
Either the published architecture has a service the list above omits, or `T3` is part of
E1. The derived mapping is sound for every other task.

## Version 2 (JISBD 2026)

Nine services in three layers.

**Data layer**

| id | service |
| --- | --- |
| D | Depot |
| O | Order and Demand |
| F | Fleet Assets |
| L | Driver and Labor Compliance |
| T | Distance and Travel Time |

**Optimization layer**

| id | service |
| --- | --- |
| R | Route Optimization Orchestrator |
| C | Classical Routing Solver |
| Q | Quantum Routing Solver |

**Execution layer**

| id | service |
| --- | --- |
| M | Telemetry and Tracking |

### The 24-hour planning workflow

R gathers O, F and D, and filters the result with L. It then calls T. It then chooses
between C and Q. It finally validates with L. M monitors during execution.

Two things in that sentence need a modelling decision rather than a transcription:

- **L appears twice**, once as a filter before T and once as a validation at the end. A
  task is invoked once per position in a workflow, so either the composition declares two
  tasks drawing on the same capability (`L_filter` and `L_validate`), or it declares one
  task and places it twice. Placing one task twice is legal and is what the container
  calls shared candidates; it means both positions bind to the *same* selected candidate,
  which is the semantically right reading here — the same compliance service is consulted
  twice. Declaring two tasks would let the solver pick two different providers for what
  is one service.
- **M monitors during execution**, which is not a step in the planning sequence. It runs
  alongside, for the duration. The planning workflow and the execution monitoring are
  arguably two compositions, or one composition with M in a parallel block whose latency
  does not aggregate into the plan. This is the sharper of the two questions and it
  changes the shape of the workflow.

### The orchestrator

**Settled in review: R is the composition itself in both versions, and gets no task.**
Version 1 already models S1 that way, and version 2 names R in the optimization layer
without R occupying a step -- what R does, gathering and choosing and validating, *is* the
workflow. The rule this follows from, and the two cases where a component the owner runs
does get a task, are section 4.1 of `docs/COMPOSITION2YAML.md`.

The decision matters because of the diff, not because of the binding. The diff the Studio
already implements reports `N tasks (M get a provider)` and a row per task present in one
revision and absent in the other, so modelling the same role two ways across versions would
print `Task R | — | present`: a change of notation dressed as a service that did not exist
before. With the rule applied to both versions, the version-to-version diff reports what
actually changed -- nine services in three layers, the parallel gather, the compliance
service consulted twice, monitoring alongside -- and nothing else. "The diff lists the added
services" is a gate of phase F1, so this had to be settled before the fixtures were written.

The `studio` block still names R in its optimization layer. That block is never emitted and
is never checked against the task set, which is exactly how the architecture view keeps a
name for the component that is the composition.

## What is already in the repository, and what is not

| | state |
| --- | --- |
| version 1 as a BIM v1 package | `examples/demo/13_fms`, compiled and pinned in the goldens |
| version 1 as a composition | to be written, and proved against that package |
| version 2 in any form | nothing; it is authored from scratch |
| the FMS pricing | in SPHERE, not in this repository |

Neither version is checked in as a *new* package. Composition sources live as
`.c2y.yaml` fixtures and are compiled into a temporary directory by the tests. This is
deliberate: the corpus package count is asserted in eight places across three CI jobs,
and adding a package to the tree breaks four goldens and two jobs at once. Version 2 gets
its own golden file instead, outside the corpus walk.
