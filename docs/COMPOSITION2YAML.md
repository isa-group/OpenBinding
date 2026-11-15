# Composition2Yaml

The problem-authoring Composition2Yaml v1 proposal was removed in F0b. It was a YAML
language for writing composition *problems* (tasks, candidates, rules, goals, placement),
defined by its translation into `qos-binding/v1` packages, with the Studio's routes under
`/v1/compositions` and a round-trip gate over the corpus. Composition problems are written
in BIM, so that language no longer has a place.

The name now belongs to a different, small document: the description of a *final*
composition (its kind, its workflow, the candidate chosen for each task with its
provenance, its global values with units, and an optional link to the problem and the
evidence it came from). It arrives with the Composition API in F1.

The old specification is in git history: the parent of the commit that removed it, and
the `pre-redesign` tag. The library it is built on lives in
`openbinding-gateway/src/openbinding_gateway/composition/`: located YAML and its
diagnostics, and the workflow tree lifted from a compiled problem's IR. The problem-side
model, the package reader, the neutral rules and the model diff were pruned in F1, since the
workflow and the facts of a problem are read from its stored IR.
