# BIM v1 authoring-conciseness benchmark

## What is measured

The acceptance metric is the number of **explicit semantic control fields** an
author must set. It measures the language control surface rather than file size.
This distinction matters: candidate observations, identifiers, and graph data
are properties of the problem, so compressing or deleting them would not make
the language easier to understand.

The following are counted:

- metric interpretation fields, including units, domains, directions, scopes,
  neutral elements, and every explicitly selected aggregation operator;
- workflow-dialect selection, while the irreducible workflow topology is not;
- constraint formulation and enforcement fields, while identifiers and
  referenced entities are not;
- optimization mode, authored weights, and normalization controls;
- routing policy selection, placement accounting, network direction, and
  global-latency controls.

The following are excluded symmetrically:

- document envelopes, metadata, annotations, digests, and resource indexes;
- identifier spelling and the coordinate fields of explicit references;
- generated catalog observations and other generated payload;
- irreducible facts such as task/candidate membership, workflow edges, routing
  probabilities, QoS samples, capacities, demands, and network latencies.

An optional field counts only when it is written. Compiler-materialized defaults
do not count. A shorthand selecting one coherent policy counts as one field;
an object overriding three independent operators counts as three. This makes the
metric sensitive to real authoring work without rewarding loss of information.

Raw bytes and raw JSON-key totals are intentionally not acceptance metrics. They
would charge BIM for strict envelopes and unambiguous references, and they would
be dominated by generated candidate data in large benchmark instances.

This benchmark does **not** claim that an equivalent problem contains 50% fewer
domain facts. Tasks, candidate observations, topology, and thresholds carry
irreducible information; deleting half of them would make a different problem.
The 50% target is therefore explicitly a reduction in the language's authored
control surface. Interpreting the target as total payload fields or bytes would
be incompatible with lossless migration and is not claimed here.

## Baseline procedure

The baseline was audited once from Git revision `6ac0751`. The audit classified
every author-controlled field using the rules above, then retained only numeric
category totals. No replaced document, fixture, parser, field name, or
compatibility path is present in the current tree. Git remains the source of
historical evidence.

The four cases cover a sequence, a probabilistic XOR, placement with capacity
and latency rules, and a Pareto problem with soft constraints. The current
packages use only BIM defaults and shorthands whose materialized behavior is
valid for the reachable workflow blocks.

| Case | Baseline controls | BIM controls | Reduction |
|---|---:|---:|---:|
| Sequence | 12 | 4 | 66.7% |
| Probabilistic XOR | 13 | 6 | 53.8% |
| Placement | 62 | 30 | 51.6% |
| Soft multi-objective | 69 | 32 | 53.6% |

## Equivalence and intentional semantic changes

Conciseness is rejected if behavior changes accidentally. The executable guard
therefore:

1. compiles each complete package through the normative BIM compiler;
2. hashes the semantic IR projection after removing only provenance, source
   locations, profile manifests, and resource digests;
3. evaluates a fixed binding with the authoritative evaluator; and
4. checks metrics, objective mode and score, normalized penalties, and
   constraint violations with a `1e-12` numeric tolerance; and
5. proves that every reachable objective value stays inside its normalization
   bounds, exhaustively for small binding spaces and by monotone extrema for the
   103,306,896-binding soft multi-objective space.

The sequence and XOR probes are exactly equal to the audited baseline equations:
the sequence has latency `30` and loss `0.03`; XOR has availability `0.950202`
and loss `0.049798`.

Two planned BIM v1 semantics cannot be numerically identical to the replaced
behavior, and the guard records them as normative changes rather than calling
them equivalence:

- Placement latency (`11`) and security (`0.66`) remain equal. The previous
  divide-across-invocations rule produced cost `8` and score `0.176` for the
  probe. BIM v1's selected-candidate scope counts the chosen candidate once,
  producing cost `10` and score `0.192`. No fixed candidate value can reproduce
  the previous workflow-dependent division for every binding.
- The soft multi-objective probe preserves availability (`0.9661922622771199`),
  cost (`1630`), and latency (`1321`). The previous evaluator collapsed the
  declared multi-objective problem to scalar `0.16266763082577926` and left its
  violated soft constraint at zero objective penalty. BIM v1 exposes the Pareto
  vector and the explicit normalized penalty `1/3`, as required by its contract.

These historical values were obtained by running the evaluator from revision
`6ac0751` in a temporary Git archive; no source artifact from that audit is kept
in the current tree. The current semantic projection adds a regression lock over
tasks, eligibility, candidate values, workflow, routing, constraints, placement,
and optimization. The range proof justifies omitting an inert clamp field; it is
not an assumption based on the single evaluation probe.

Run the guard with:

```bash
python tools/check_bim_conciseness.py
```

Use `--json` for the complete category, digest, and evaluation report. The same
guard runs as a pytest acceptance test.
