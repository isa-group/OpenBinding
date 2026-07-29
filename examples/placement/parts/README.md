# One instance, written as its parts

An instance is `I' = (M_A, M'_C, Δ, O)`, with `M_A = (T, G, Λ)` and
`M'_C = (P, C, F, R, L)`. Written whole, everything two deployments of the same
application have in common is written twice. Written in parts, it is written
once.

This directory is the same small placement problem deployed two ways:

```
shared/          the application and how it is judged - identical for both
  tasks.json                  T       what the application does
  composition.json            G       how those tasks are orchestrated
  aggregation-policies.json   Λ       how a feature composes along G
  constraints.json            Δ       what a binding must satisfy
  objective.json              O       how eligible bindings are ranked

edge-heavy/      one infrastructure: edge, fog and cloud pools
cloud-only/      the same application with the edge pools removed
  providers.json              P
  candidates.json             C
  features.json               F
  resource-model.json         R       pools and their capacities
  latency-model.json          L       the network between them
  normalization.json                  per-instance bounds (see below)
  metadata.json
```

Compose either one:

```bash
python openbinding-gateway/tools/bim_parts.py compose \
    examples/placement/parts/shared examples/placement/parts/cloud-only \
    -o /tmp/cloud-only.json
```

The result is an ordinary instance; `POST /v1/solve` is unchanged and knows
nothing about parts.

## In the Playground

The same split is available over HTTP - `POST /v1/instance/split` and
`/v1/instance/compose` - and the Playground uses it: pick **Placement —
edge-heavy (parts)** or **cloud-only (parts)** from the example list, and the
instance opens as one editor per file, grouped by the model each belongs to.
Solving from that view composes them first, so what is solved is exactly what
the parts describe. The **Whole** / **Parts** toggle converts either way at any
time.

## Why both infrastructures declare the same candidate ids

A candidate lists the tasks it can implement, so one deployment on a pool is one
candidate serving all five functions rather than five near-identical ones. Both
infrastructures therefore describe themselves with `c_fog` and `c_cloud`, and
`edge-heavy` adds `c_edge`. Cost is declared `DIVIDE`, so the functions that end
up on one pool split what that pool costs, and its memory is taken up once.

## Why normalization is its own file

The canonical objective normalizes each feature against declared bounds, and
those bounds are derived from the candidates of *that* instance. Leaving them
inside `aggregation-policies.json` would make an otherwise reusable file differ
per deployment for a reason that has nothing to do with the application. They
are a thin overlay instead, merged onto the policies at composition time - the
one place where composition is not a plain merge of disjoint keys.

## Taking an existing instance apart

`split` is the inverse of `compose`, and the two are checked to round-trip over
every instance in the repository:

```bash
python openbinding-gateway/tools/bim_parts.py split \
    examples/placement/01_small_placement.json -o /tmp/parts
```

`regroup` does it for a whole corpus, writing each distinct part once. On the
105 ICSOC instances - three applications over 35 infrastructures - that turns
105 copies of `tasks` and `composition` into 3 each, and 105 copies of
`providers` and `objective` into 1 each.
