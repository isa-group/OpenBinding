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

Modelling S2 as a `local` task is the right call and worth preserving: an in-house
component is deliberately outside the candidate market, so it never binds and contributes
each property's neutral. This is why Composition2Yaml needs a `local` task kind and not
only open and fixed ones.

The package declares five properties: `cost` (USD/month), `execution_time` (ms),
`availability`, `reliability` and `security` (a 1 to 5 score). Their neutrals, all
inferred by the container from the sequence operator and the domain, are `0.0`, `0.0`,
`1.0`, `1.0` and **`5.0`** — the last one because `security` aggregates with `min` over a
real domain bounded at 5, so the value that does not constrain a minimum is the upper
bound. Getting that one wrong is the sharpest trap in the whole case.

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

Version 1 models its orchestrator (S1) as the composition itself, with no task. Version 2
names R as a service in the optimization layer. If R is the composition, it should not be
a task; if R is a service that can be bound to competing providers, it should. The two
versions currently model the same role differently, and the version-to-version diff will
report that as a change when it may only be a change of notation.

This is the first question to settle, because it decides what the diff of the guiding case
actually says — and "the diff lists the added services" is a gate of phase F1.

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
