# Slice H: how to test

## See it
1. Open the Workbench and check a package whose gateway answer carries diagnostics.
2. Each diagnostic line shows its code and then its message. With no message, the detail is shown. With neither as
   text, the line reads "The gateway sent no message for this diagnostic." No JSON of the item is ever shown.
3. The engine detail page still shows the registration conformance report (`RegistrationReportView`). The old
   engine-answer view (`EngineReportView`) and its CSS are gone.

## Tests
- `frontend/src/pages/Workbench/CheckResult.test.tsx`: diagnostic text rules.
- `frontend/src/components/EngineReportView/EngineReportView.test.tsx`: only the registration report remains; the
  retired view and CSS rules are absent.
- `frontend/src/test/rawRenderingHygiene.test.ts`: allow-list holds 10 offenders (1 and 4 retired).
- `frontend/src/routes/retiredScreens.test.tsx`: pins `MAX_ALLOWED_OFFENDERS` at 10.

Run: `cd frontend && pnpm exec vitest run src/components/EngineReportView src/pages/Workbench/CheckResult.test.tsx src/test/rawRenderingHygiene.test.ts src/routes/retiredScreens.test.tsx`
