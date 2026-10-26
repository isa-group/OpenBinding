# Change: m02-openspec-strict

## Why

ROADMAP M0.2: `openspec validate --strict --all` must exit 0. Today the living specs under `openspec/specs/` fail the
validator on requirement text length.

## What Changes

- Requirement text of the over-long requirements is shortened (MODIFIED delta, complete block each).
- Headers, `req~...~N` ids and revisions stay byte-identical; wording changes do not bump a revision.
- Scenarios stay unchanged. No obligation, number, status code or boundary is dropped.

## Impact

- Capabilities: `engine-minizinc`, `engine-registry`, `engine-protocol`, `engines-java` (this slice); other capabilities are
  added by later slices of the same change.
- No code, API, database or BIM contract change. Traceability tags `[impl->req~x~N]` / `[utest->req~x~N]` stay valid
  because no id or revision changes.
- Risk: low; documentation of existing requirements only.

## Out of scope

- Any change of meaning of a requirement (that needs a revision bump in its own change).
- Unarchived changes other than this one.
