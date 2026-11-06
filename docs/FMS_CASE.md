# The guiding case: a hybrid fleet management SaaS

OpenBinding Studio is developed against one guiding case, in two architectural versions:
the hybrid SaaS fleet management system (FMS). Both papers were read while writing this
document, and the figures settle several things that were guessed at here before:

- **Version 1** is Ruiz-Cortes and Parejo, *An Initial Exploration of Pricing-driven
  Governance for Hybrid Quantum-Classical SaaS*, JISBD 2025 (Cordoba), track on Quantum
  Computing and Quantum Software Engineering, `hdl.handle.net/11705/JISBD/2025/91`. Its
  Figure 1 is the architecture this version models.
- **Version 2** is Parejo and Ruiz-Cortes, *Operationalizing Quantum Optimization for
  Multi-Depot Logistics: A Hybrid service-oriented Approach*, JISBD 2026 (Alicante),
  `hdl.handle.net/11705/JISBD/2026/124`. Its Figure 1 and section 2.2 are the architecture
  and the workflow this version models.

Not to be confused with the tool paper: *OpenBinding: A QoS-Aware Service Composition API
Gateway with Pluggable Engines*, JCIS 2026, `hdl.handle.net/11705/JCIS/2026/41`. It uses
the same FMS scenario but states that it "intentionally set[s] aside additional
scenario-driven complexities -- such as the pricing configuration space, hybridity, and
continuous change", so it carries no task breakdown and settles nothing here.

This document records what each version is, how version 1 maps onto the package already in
the corpus, and what is still undecided.

Why it matters beyond illustration: version 1 is already modelled as a BIM v1 package, so
it is the reference against which the Composition2Yaml translation is proved. The
translation is faithful when the composition written by hand compiles to a package whose
IR digest equals the existing one.

## Version 1 (JISBD 2025)

Six services, two of them in-house. The names are the paper's own, read off Figure 1 and
section 2 of the JISBD 2025 paper: "a composition of two internal services (S1-S2),
provided by the HSaaS owner, and four external services (E1-E4), provided by third
parties."

| id | service | nature |
| --- | --- | --- |
| S1 | Routing | in-house, the orchestrator |
| S2 | Classic Routing | in-house |
| E1 | Vehicle Position Monitoring | external |
| E2 | Quantum Routing | external (deployable on IBM Quantum, Amazon Braket, ...) |
| E3 | Billing and Payment | external |
| E4 | Cloud Deployment | external (the PaaS/IaaS FMS runs on) |

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

### The missing T4, recovered

**There is no T4 because the fourth step of the workflow was never a task.** This was an
open question in this document and the answer was in the repository's own history the whole
time, in the ancestor of the package at commit `2eb0d7bbd8` ("feat: new demo instance"):

```
git show 2eb0d7bbd8:examples/demo/13_fms.json
```

That file declares exactly five tasks -- `T1` Cloud Deployment, `T2` Telemetry and
Tracking, `T3` Distance and Travel Time, `T5` Quantum Routing, `T6` Billing and Payment --
and its workflow's fourth position is an `XOR` whose 0.8 branch is `node_classic_routing`,
carrying `"kind": "ELEMENT"` where every other node carries `"kind": "TASK"` with a
`task_id`, and this description:

> Classic routing path executed outside the selectable candidate set.

So nothing was dropped. The numbers belong to the `task_id` namespace, the in-house
classical solver was deliberately placed outside it, and the gap is the visible trace of
that modelling choice rather than a lost service. Section 4.1 of
`docs/COMPOSITION2YAML.md` is now the rule that choice follows, and the gap is a signpost
to it: today the same component would be weighed as `local` against `fixed`, and version 2
of this case models it as `fixed` with real values.

**What the paper settles, and what it does not.** This document used to offer a second
explanation -- "the numbering was kept aligned with a figure in the paper" -- and the paper
refutes it: Figure 1 of the JISBD 2025 paper labels its services `S1`, `S2` and `E1` to
`E4` and carries no task numbering at all, so there is no `T4` in any figure to align with.
The T-numbers are the package's own. The paper therefore cannot confirm the reading above
either; the commit is the whole of the evidence, and it is an inference about intent rather
than a sentence from the author.

Two things follow for phase F1. The task ids are reproduced verbatim and **renumbering is
refused**, not merely expensive: the frozen-baseline equivalence checks pin this package's
digests. And the reason belongs where the reader who would "fix" the gap is actually
looking -- the hand-written `.c2y.yaml` fixture of step 7, as a comment above its `tasks:`
block and as the composition's own `description`, both of which are free of every digest.

*To confirm against the published figure.* The commit gives the positions and the names, not
a sentence from the author saying "position 4 is the classical solver", and the JISBD 2025
paper is not in this repository. The reasoning above is written out so it can be checked
against the figure in one reading.

### T3 is a seventh service, and version 2 is where it becomes official

The other half is settled by the two papers together. The JISBD 2025 figure names exactly
six services -- `S1` Routing, `S2` Classic Routing, `E1` Vehicle Position Monitoring, `E2`
Quantum Routing, `E3` Billing and Payment, `E4` Cloud Deployment -- and **none of them is a
distance or travel-time service**. The ancestor commit names `T2` "Telemetry and Tracking"
and `T3` "Distance and Travel Time", and the two tasks admit disjoint candidate markets
(Radius IoT and Samsara against HERE and Distance Matrix), so `T3` is not part of `E1`.

So `T3` is not a service the 2025 paper omitted: it is one the package **added**. Version 2
is where it becomes part of the published architecture, as `Distance & Travel Time (T)` in
the Data & Assets layer of the JISBD 2026 figure. The six-service table above is the 2025
paper's list and is correct as published; the package has seven.

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

The paper's section 2.2 gives it as four sequential phases, and reading it settles both
questions this section used to leave open:

1. **Context aggregation.** R fetches pending demands from O, vehicle capacities from F and
   depot windows from D, "while filtering driver availability via (L)".
2. **Spatial-temporal mapping.** R invokes T for the travel-time matrix.
3. **Hybrid governance and solving.** R formalizes the instance, assesses its structural
   complexity and invokes C or Q.
4. **Validation and dispatch.** R validates the solution "against compliance rules (L)" and
   persists the routes. "During execution, (M) monitors real-time GPS data, allowing (R) to
   detect deviations and trigger re-optimization if necessary."

So:

- **L is consulted twice and it is one service, not two.** Phases 1 and 4 both name `(L)`,
  the same Driver & Labor Compliance Service of Figure 1. The composition therefore declares
  one task and places it twice -- what the container calls shared candidates, where both
  positions bind to the *same* selected candidate. Declaring two tasks would let the solver
  pick two different compliance providers for what the architecture has as one service.
- **M is a feedback loop, not a step.** It is not in the planning sequence at all: Figure 1
  puts it in its own Execution Layer above the optimization tier, sending "Real-time
  updates" to R, and the text has it monitoring *during* execution so that R can trigger
  re-optimization. It is the sharper of the two questions and the paper answers it: the
  planning workflow is what a composition models, and monitoring is the loop around it.
  Putting M in a parallel block inside the plan would make its latency aggregate into the
  planning latency, which is a claim the architecture does not make.

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
deliberate: the corpus package count is asserted in fourteen places across three CI jobs,
nine checked-in golden files enumerate every current package by path, and adding one to
the tree breaks several of each at once. Version 2 gets its own golden file instead,
outside the corpus walk.

Which packages version 1 has to reproduce is settled, and it is not "the demo examples":
section 11.2 of `docs/COMPOSITION2YAML.md` names the live golden's 82 packages minus the
seven that declare a Placement resource. Eight of the 20 demo packages would have failed
the phrase it replaces, five of them for a limit no section had stated.
