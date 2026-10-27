## ADDED Requirements

### Requirement: Verdict badge knows the API terminations
WHEN `VerdictBadge` receives the verdict `INFEASIBLE` or `UNKNOWN`, THE `VerdictBadge` component SHALL render it as a known verdict: the verdict word as badge text in the variant that design.md §1 gives for it, followed by that row's visually hidden description.

`req~frontend-rendering-verdict-terminations~1`

Needs: impl, utest

Evidence: `frontend/src/components/rendering/VerdictBadge.test.tsx`; `frontend/src/components/rendering/VerdictBadge.tsx`

With this requirement, every termination the gateway returns (`OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN`) is a
known verdict. The markup, sizes, reasons list and the five verdicts of `req~frontend-rendering-verdict-badge~1`
are unchanged (design.md §3).

#### Scenario: The two terminations as known verdicts
- **GIVEN** each row of: `INFEASIBLE` / `error` / `no combination meets the rules`; `UNKNOWN` / `default` / `no conclusion`
- **WHEN** `<VerdictBadge verdict={verdict} />` is rendered
- **THEN** the verdict text has the classes `badge` and `badge-<variant>`
- **AND** the wrapper of the badge has the text `<verdict>, <description>` and no `aria-describedby`
- **AND** the wrapper contains an `.sr-only` element whose text is `, <description>`, so `INFEASIBLE` is read as `INFEASIBLE, no combination meets the rules`

#### Scenario: Every API termination has a description
- **GIVEN** the verdicts `OPTIMAL`, `FEASIBLE`, `INFEASIBLE` and `UNKNOWN`
- **WHEN** each is rendered with `<VerdictBadge verdict={verdict} />`
- **THEN** each render has exactly one `.sr-only` element, with non-empty text after `, `
- **AND** the four descriptions are pairwise different

#### Scenario: Infeasible is told apart from unsat
- **GIVEN** `<VerdictBadge verdict="INFEASIBLE" />` and `<VerdictBadge verdict="UNSAT" />`
- **WHEN** each is rendered
- **THEN** both badges have the class `badge-error`
- **AND** their wrappers read `INFEASIBLE, no combination meets the rules` and `UNSAT, no combination satisfies the rules`

#### Scenario: Reasons with a termination
- **GIVEN** `<VerdictBadge verdict="INFEASIBLE" reasons={['Hard rule latency ≤ 600 ms fails for every candidate']} />`
- **WHEN** it is rendered
- **THEN** a list named `Reasons` holds `Hard rule latency ≤ 600 ms fails for every candidate`, after the badge in document order
- **AND** the outermost element is a `<div>` and there is no `<pre>`

#### Scenario: Other spellings stay unknown
- **GIVEN** `<VerdictBadge verdict="infeasible" />`, `<VerdictBadge verdict="Unknown" />` and `<VerdictBadge verdict="toString" />`
- **WHEN** each is rendered
- **THEN** the text `infeasible`, `Unknown` or `toString` is shown in a badge of class `badge-default`
- **AND** the wrapper of the badge has that text only and there is no `.sr-only` element
