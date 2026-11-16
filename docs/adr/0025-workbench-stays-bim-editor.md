# 0025. The Workbench stays as the BIM problem editor

- Status: superseded by [ADR 0051](0051-problem-editor-on-the-shared-core.md)
- Date: 2026-11-14 (F0b, decision D4 of the F0b implementation plan)

## Context

The first F0b plan retired the Workbench. The owner decided that composition problems are written in BIM, and F2's
editor is a Composition2Yaml editor plus a BIM problem editor, so the only BIM editor could not go without a
replacement.

## Decision

The Workbench stays in `frontend/src/pages/Workbench/` as the organization's BIM problem editor at
`/app/:org/workbench`. F0b removed only what it deleted from under it: running from a snapshot and the
ExecutionConfiguration picker (B4), and the snapshot and save-to-project endpoints, rebound to the problems API and the
`/v1/bim` services (B5, ADR 0036). The forms, the BPMN modeler, the source panel, the draft and undo store and the
check result are unchanged. Nothing runs from the Workbench: a saved version runs from its problem page.

## Consequences

- The draft and undo store is extracted in F2, when the Composition2Yaml editor shares it; `BpmnModeler` and
  `formParts` stay with the BIM editor.
- The screen id stays `wb-workbench` (screen ids are renamed with F2's information architecture).
- `frontend/e2e/f0b-walk.spec.ts` walks an edit and a template through it to a saved version.

Where: `frontend/src/pages/Workbench/`, `frontend/src/routes/areas/problems.tsx`.

Later: F2b replaced the Workbench with the problem editor in `frontend/src/features/bim-editor/` at
`/app/:org/problem-editor` and deleted `pages/Workbench` ([ADR 0051](0051-problem-editor-on-the-shared-core.md)).
