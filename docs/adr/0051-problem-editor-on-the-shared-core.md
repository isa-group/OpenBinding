# 0051. The BIM problem editor on the shared core

- Status: accepted; supersedes [ADR 0025](0025-workbench-stays-bim-editor.md)
- Date: 2026-11-16 (F2b, decisions D9, D11 and D15 of the F2 implementation plan; plan decision 12: the BIM editor on
  the core shared with the renderer)

## Context

ADR 0025 kept the Workbench as the organization's BIM problem editor until F2 could replace it. It was a shell of its
own: forms, a BPMN modeler, a source panel, a check result with its own diagnostics wording, and a structure view
drawn from the package files in the browser. F2a built the shared core the problem and composition screens draw
with: the facts projection of a compiled problem ([ADR 0048](0048-problem-facts-projection.md)), `WorkflowGraph`,
`CandidateMatrix`, `ValueBadge`, `ProblemsPanel`, `Located`, the draft store and the live-check scheduler
([ADR 0050](0050-frontend-layers-and-sphere-reuse.md)). The public Workbench (`/workbench`,
[ADR 0037](0037-anonymous-workbench-stays.md)) still read the package files itself (`packageModel.ts`), a second
reader of BIM.

## Decision

- **One editor, a feature.** `frontend/src/features/bim-editor/` holds the editor (`ProblemEditor`,
  `useProblemEditor`), its panes (Workflow, Candidates, Rules, Files, Forms, BPMN), the resource forms, the BPMN
  modeler and the matrix edits. `pages/Problems/ProblemEditorPage.tsx` mounts it at `/app/:org/problem-editor`
  (screen `problem-editor`): `?template=`, `?problem=&revision=`, and `&composition=&compositionVersion=` to show a
  composition version's choice on its problem (the problem page's query names; the plan said `version`). It opens,
  in this order, the template the address names once the gateway accepts it, the draft this browser kept, the problem
  version's source, or the blank package.
- **Live checks within the compile budget** (D8). `POST /v1/bim/validate?include=facts` runs through the shared
  scheduler 2000 ms after the last edit, only when every JSON file parses; a new edit aborts the check in flight, a
  `429` pauses checks for `Retry-After`, and "Check now" asks at once. The budget is the `compile` class (10 / 50 per
  minute); nothing on the gateway changed for it.
- **The matrix from the last checked facts** (D9). The graph, the matrix, the rules and the engines are drawn from
  the facts of the last package the gateway accepted. After a refusal they stay, marked stale, beside the findings;
  the editor never infers eligibility or a candidate's task from the files.
- **Edits are written to the sources through origins.** A value edited in a matrix cell is written to the file and
  JSON pointer its facts origin names (a number over a number in place; anything else by rewriting that document).
  A cell is pending while its source value differs from the last valid facts value: the state is computed, not
  stored, so a passing check, an undo or a pane switch settles it. A new candidate appears in the matrix after the
  next check.
- **Findings are located once.** `shared/diagnostics/bim.ts` (`fromBim`, `fromBimAll`) places each finding of the
  compiler on a range of a JSON file (`jsonPointer.ts` resolves the pointer and an expression's span on the parsed
  text), a BPMN element, a file or the package. The same `Located` list feeds the Problems panel, the matrix cells,
  the Files pane's lint and the rules' "written in" links.
- **One undo history** (D15). The draft store keeps the package's 40-step history; each form or matrix edit is one
  step, and each diagram the BPMN modeler accepts is one step while the modeler keeps its own stack.
- **Saving.** "Save as version…" is enabled only when the package on screen passed its last check; it creates a
  problem or a new version of one with `producer=openbinding-problem-editor`, which the gateway records as the origin
  `editor`, and forgets the draft.
- **The public Workbench on the same core** (D11). `/workbench` asks `validate?include=facts`: a valid package is
  drawn with the analysis counts, the binding-space badge, `WorkflowGraph`, `CandidateMatrix` (view) and the rules; a
  refused one shows the gateway's findings, placed in its files, and no structure. A signed-in visitor opens the
  problem editor of an organization; a template is carried by `?template=`, an uploaded file is not (it is uploaded
  from the problem list).
- **Deleted:** `pages/Workbench` whole (shell, check result, structure and digest views, compiled IR and YAML views,
  import and export of `.bim.zip`, the legacy-vocabulary draft migration), `utils/bimVocabulary.ts`,
  `utils/workspaceViews.ts`, `e2e/s5d-workbench.spec.ts`, and the public Workbench's `packageModel.ts`,
  `diagnostics.ts` and `WorkbenchResult.tsx`.

## Consequences

- The editor, the problem page and the composition screens draw the same graph and matrix from the same facts
  (`src/test/sameCoreDom.test.tsx`), and no client code reads BIM source files to draw a problem.
- A package that never passes a check shows no structure; its findings say why.
- A value the compiler would normalise differently from how it was typed stays pending after the check.
- Import and export of `.bim.zip` in the editor are gone; a package enters through the problem list's upload or a
  template, and leaves as a problem version's source.

Where: `frontend/src/features/bim-editor/`, `frontend/src/pages/Problems/ProblemEditorPage.tsx`,
`frontend/src/shared/diagnostics/bim.ts`, `frontend/src/shared/diagnostics/jsonPointer.ts`,
`frontend/src/pages/Public/PublicPages.tsx`, `frontend/e2e/f2b-problem-editor.spec.ts`,
`frontend/e2e/live/10-problem-editor.spec.ts`.
