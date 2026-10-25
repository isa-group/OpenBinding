M2.4 screens-first, one PR per screen group, in the brief's order. This PR is slice 1, the decision-space workspace. Remaining slices, each its own PR on the same recipe (OpenSpec delta, red tests, implementation, review panel, how-to-test guide):
2. Report editor: routes rep-list and rep-detail (RepList, RepDetail, NewReport, PublishDialog, ReportBlocks, SaveReport already gone); offender 5 leaves the allow-list; pages/Reports/SavedDecision.tsx and src/analysis parts that become dead go with it; proj-publications and the verifier stay.
3. Library catalogue and project resources: lib-list, lib-artifact, lib-draft, lib-version, proj-library, proj-resources, proj-resource-detail; offender 11 (Library/ContentView.tsx) leaves.
4. Composer: case-composer.
5. Sponsorship: admin-sponsor, AdminSponsor and its usage hook.
Each slice appends entries (with its slice number) to frontend/src/routes/retiredRoutes.tsx, lowers MAX_ALLOWED_OFFENDERS to the number of entries, and updates the ROADMAP status paragraph. Backend endpoints and Deprecation/Sunset headers stay a separate step that needs an owner CRP.
