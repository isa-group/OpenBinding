# BIM v1 model atlas

This atlas explains BIM from its smallest reusable container concepts through
Profile and Dialect extension, the executable QoS-binding language, canonical
IR, Engine compatibility, and concrete instances. The numbered levels are
progressive **views of BIM v1**, not new language versions.

The JSON Schemas, installed manifests, compiler, and evaluator remain
normative. Every diagram here is either a `normative-derived` projection of
those sources or an `informative` view of a checked-in example. A diagram must
not be used to invent behavior absent from its listed sources.

## Reading order

| Level | Chapter | Question answered |
| --- | --- | --- |
| 0 | [Foundations](00-foundations.md) | What is the smallest BIM package and reference model? |
| 1 | [Profiles and Dialects](01-profiles-and-dialects.md) | How can the container acquire problem-family and domain semantics? |
| 2 | [QoS-binding Profile](02-qos-binding.md) | What source model does the executable v1 Profile accept? |
| 3 | [Dialect details](03-dialect-details.md) | How do Placement and BPMN extend that Profile? |
| 4 | [IR and execution](04-ir-and-execution.md) | How is source lowered, matched to an Engine, solved, and checked? |
| 5 | [Instances and catalog](05-instances-and-catalog.md) | Which concrete models and corpus families exercise the framework? |

Authors can read levels 0, 2, 3, and 5. Profile or Dialect implementers should
read levels 0 through 4. Engine implementers should start with levels 2 and 4,
then use level 5 for conformance examples.

## Terms and notation

- **Metamodel** describes the permitted types, associations, cardinalities,
  and invariants of a BIM document family.
- **Model** is a conforming Profile, Dialect, source language, IR, or Engine
  contract.
- **Instance** is one concrete object graph, such as
  `examples/demo/01_simple_seq` or the installed `qos-binding/v1` Profile.
- A filled diamond in PlantUML means composition; an open diamond means shared
  aggregation; ordinary arrows mean references or data flow. Multiplicities
  are taken from schemas and semantic validation, not guessed from examples.
- Stereotypes mark the owning layer: `core`, `profile`, `dialect`, `source`,
  `IR`, or `execution`.
- Mermaid is used only for architectural flow and temporal sequence. PlantUML
  is the source of formal class and object diagrams; the adjacent SVG is a
  committed rendering of that source.

## Formal diagram traceability

| Diagram | Status | Primary sources |
| --- | --- | --- |
| `00-core-metamodel` | normative-derived | [`instance.schema.json`](../../schemas/bim/v1/instance.schema.json), package validation in [`package.py`](../../openbinding-gateway/src/openbinding_gateway/v1/package.py) |
| `01-profile-metamodel` | normative-derived | [`profile.schema.json`](../../schemas/bim/v1/profile.schema.json), installed contracts in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `01-dialect-metamodel` | normative-derived | [`dialect.schema.json`](../../schemas/bim/v1/dialect.schema.json), Dialect installation in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `01-installed-framework` | informative | Built-in Profile and Dialect manifests returned by [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `02-qos-package` | normative-derived | The installed `qos-binding/v1` Profile and source schemas under [`schemas/bim/v1`](../../schemas/bim/v1/) |
| `02-application-workflow` | normative-derived | [`application.schema.json`](../../schemas/bim/v1/application.schema.json), workflow lowering in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `02-catalog-eligibility` | normative-derived | [`candidate-catalog.schema.json`](../../schemas/bim/v1/candidate-catalog.schema.json), candidate normalization in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `02-constraints-expressions` | normative-derived | [`constraint-set.schema.json`](../../schemas/bim/v1/constraint-set.schema.json) and [`expressions.py`](../../openbinding-gateway/src/openbinding_gateway/v1/expressions.py) |
| `02-optimization-routing` | normative-derived | [`optimization.schema.json`](../../schemas/bim/v1/optimization.schema.json) and [`routing-overlay.schema.json`](../../schemas/bim/v1/routing-overlay.schema.json) |
| `03-placement-allocation` | normative-derived | Allocation and capacity portions of [`placement.schema.json`](../../schemas/bim/v1/placement.schema.json), plus Placement lowering in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `03-placement-network` | normative-derived | Network and event portions of [`placement.schema.json`](../../schemas/bim/v1/placement.schema.json), plus Placement validation in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `03-placement-latency` | normative-derived | Transition and global-latency portions of [`placement.schema.json`](../../schemas/bim/v1/placement.schema.json), plus canonical evaluation in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `03-small-placement` | informative | [`examples/placement/01_small_placement`](../../examples/placement/01_small_placement/) |
| `03-bpmn-mapping` | normative-derived | [BPMN contract](../BPMN.md), vendored OMG schema, and BPMN lowering in [`compiler.py`](../../openbinding-gateway/src/openbinding_gateway/v1/compiler.py) |
| `04-binding-problem-ir` | normative-derived | [`binding-problem.schema.json`](../../schemas/bim/v1/binding-problem.schema.json) and canonical lowering |
| `04-engine-metamodel` | normative-derived | [`engine.schema.json`](../../schemas/bim/v1/engine.schema.json), [`engine-registration.schema.json`](../../schemas/bim/v1/engine-registration.schema.json), compatibility in [`routes/v1.py`](../../openbinding-gateway/src/openbinding_gateway/routes/v1.py) |
| `05-simple-sequence` | informative | [`examples/demo/01_simple_seq`](../../examples/demo/01_simple_seq/) |
| `05-bpmn-json-twins` | informative | [`15_bpmn_complete`](../../examples/demo/15_bpmn_complete/), [`16_json_complete`](../../examples/demo/16_json_complete/), and their [regression test](../../openbinding-gateway/tests/test_complete_bpmn_json_regression.py) |
| `05-federated-engine` | informative | [`multi-heuristic`](../../examples/federation/multi-heuristic/) Engine and Registration example |

## Maintaining the atlas

Edit Mermaid in its chapter and edit formal diagrams only in
[`plantuml/`](plantuml/). Regenerate the committed SVGs with:

```bash
tools/render_bim_diagrams.sh
tools/render_bim_diagrams.sh --check
```

The renderer is pinned and runs without network access. `--check` renders into
a temporary directory and fails for stale, missing, or orphaned SVGs. When a
schema, installed manifest, lowering rule, Engine capability contract, or
canonical example changes, update every diagram that names it in the table
above.
