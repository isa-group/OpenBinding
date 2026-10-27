Goal: M2.4 slice 5, retire the admin sponsorship screen (ADR-0020), same pattern as slice 4 (PR #65).
State: spec, source+tests (vitest 2424 pass, tsc/eslint ok), e2e specs, ROADMAP status, how-to-test and changelog are integrated on change/m24-retire-sponsorship. Playwright specs not run by workers; CI is the first run.
Decisions: only the admin-sponsor screen retires; target /app/admin; the SponsorshipTool (AdminOverview) and OrganizationsCard (AdminUserDetail) are removed, not repointed; org-level sponsor flows (OrgSettings, SponsorCards, SponsorRequestsForYou, useSponsorUsage) and the API client stay; no Deprecation/Sunset; MAX_ALLOWED_OFFENDERS stays 12; SUB_ORG fixture kept (e2e uses it).
Risks: administrators lose the UI to transfer sponsorship (endpoint remains); e2e unverified; changelog is derived from git log so a later docs commit can make it stale.
Next: push, open PR, watch CI (fix e2e/changelog if red), review panel medium (reviewer + test-reviewer), set_review_package, lead_ready.
Owner follow-up: whether the org-level sponsor flow retires too.
