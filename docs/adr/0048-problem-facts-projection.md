# 0048. One facts projection of a compiled problem, with the workflow in Composition2Yaml's shape

- Status: accepted
- Date: 2026-11-16 (F2a, decisions D4, D9 and D25 of the F2 implementation plan; plan decision 12: the BIM editor on
  the core shared with the renderer)

## Context

The screens that draw a problem (the problem pages, the run result and the launcher) read the compiled IR in the
browser (`pages/Cases/bindingModel.ts`): eligibility, routing, the workflow tree and the size of the binding space.
That was a second reader of BIM, and it disagreed with the gateway in places: the IR writes its workflow as
`sequence|parallel|exclusive|repeat`, Composition2Yaml as `seq|and|xor|loop`, and only the gateway knows how a
candidate is named when two catalogs share an id. The composition renderer and, in F2b, the BIM editor need the same
graph and the same matrix as the problem pages.

## Decision

- **One projection, served by the gateway.** `GET /v1/organizations/{org}/problems/{problem}/revisions/{revision}/compilations/{compilation}/facts`
  (`{compilation}` is an id or a `compilation_digest`) serves the facts of a stored compilation, and
  `POST /v1/bim/validate?include=facts` (anonymous allowed; `include=ir,facts` for both) serves those of a draft
  package. Both answer `ProblemFactsView`: the tasks with their kind, the candidates of each task with their
  **written** name, provider and feature values (number or range, unit, origin `{kind: package, resource, path,
  pointer}`), the features with direction and whether a constraint needs them, the constraints (`expression`, and the
  raw `when` and `penalty`) and objectives, the size of the binding space, and the workflow.
- **The workflow in Composition2Yaml's JSON shape.** The workflow is written as a composition would write it
  (`text.workflow_json(derive.written(facts.workflow))`, the functions derive already uses), so the facts' workflow
  of a problem equals the workflow of a document derived from it. The frontend has one input shape for
  `WorkflowGraph`, for problems and compositions alike.
- **The naming rule lives in the gateway only.** A candidate is written `<id>`, or `<resource>/<id>` where two
  catalogs share an id (`composition/problem.py`). `EvaluationView.binding` uses the same key string, so a version's
  chosen candidate is compared with the facts' candidates as identifiers, never parsed.
- **The library stays pure.** `composition/facts.py` builds the view from the IR, the source map and the analysis it
  is given (`ir_digest` is passed in: the library may not import the toolchain). The facts route compiles nothing and
  has no work limit, as the IR route. A compiled problem the projection cannot read is `422 problem_facts_unreadable`;
  an unknown `include` item is `422 validation_error`.
- **The client reader is deleted.** `entities/problem/facts.ts` reads the facts (with an ETag cache);
  `entities/binding/workflowGraph.ts` and `candidateMatrix.ts` are the shared view-models; the problem pages, the run
  result, the launcher and the version compare of a problem read them, and `bindingModel.ts` is gone (D25).
- **Fixtures come from the gateway.** `tools/dump_frontend_fixtures.py` drives the real app and writes
  `frontend/src/test/fixtures/core/*.{facts,validate,version,diff}.json` for `simple-seq`, `fms`, `json-complete` and
  `ambiguous` (built in code: a second catalog that also provides `t1`), with ids and instants normalised;
  `--check` fails when they drift.

## Consequences

- "The same graph and matrix in the renderer and in the BIM editor" is a property of their input, asserted by the
  gateway (stored facts equal validate facts; the facts workflow equals a derived document's) and again in the
  frontend (`entities/binding/sameCore.test.ts`).
- The frontend never computes eligibility, never copies the naming rule and never reads the IR. Draft checks in the
  BIM editor (F2b) read the facts of `validate`, under the `compile` budget.
- The facts carry no profile, dialects, adapters, placement pools or display names; screens that showed them read the
  compilation's resources and analysis instead.

Where: `composition/facts.py`, `composition/problem.py`, `composition/text.py`, `modules/problems/adapters/routes.py`,
`modules/problems/application/facts.py`, `modules/problems/adapters/bim_routes.py`, `tools/dump_frontend_fixtures.py`,
`frontend/src/entities/problem/`, `frontend/src/entities/binding/`; tests `tests/composition/test_facts.py`,
`tests/test_problem_facts_api.py`.
