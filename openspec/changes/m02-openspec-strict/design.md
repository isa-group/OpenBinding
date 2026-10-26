# Design: m02-openspec-strict

## Rule counted

Each requirement block (statement, id line and Evidence line, up to the first `#### Scenario`) stays under 500
characters; the target is 400-450 so that a hand count (about 15 characters of error) cannot cross the limit. The
earlier slices of M0.2 (`docs/agent-work/m02-specs-a` to `-d`) use the same rule.

## Shortening rules

1. Headers, `req~...~N` ids and revisions stay byte-identical. A rewording never bumps a revision.
2. No obligation, number, status code or boundary is dropped from the statement.
3. Evidence lines cite test files instead of every test function, keep at least one test or source file per clause, and
   drop secondary files already covered by another cited file.
4. Scenarios are copied unchanged.
5. A requirement that cannot be brought under the limit without changing meaning is left out and reported.

## Verification

Every touched id was searched in the repository outside `openspec/`: none carries an `[impl->...]` or `[utest->...]`
tag, so no tag is affected.
