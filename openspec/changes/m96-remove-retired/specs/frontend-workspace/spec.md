## ADDED Requirements

### Requirement: No client binding of a removed operation
`req~frontend-workspace-no-removed-operation-binding~1`
THE frontend's non-test sources under `frontend/src` SHALL contain no client binding of an operation removed by M9.6 and no request path of one.

Needs: impl, utest

#### Scenario: Sources after this change
- **GIVEN** every `.ts` and `.tsx` file under `frontend/src` except `*.test.ts`, `*.test.tsx` and `frontend/src/test/**`
- **WHEN** the test searches them for the bindings `analysisApi`, `platformApi.report`, `platformApi.createReport`, `platformApi.freezeReport`, `platformApi.createReportDraft`, `platformApi.updateReport`, `platformApi.deleteReport`, `platformApi.publishReport`, `platformApi.createResource`, `platformApi.createResourceRevision`, `platformApi.resource`, `platformApi.updateResource`, `platformApi.deleteResource`, `libraryItemsApi.create`, `libraryItemsApi.item`, `libraryItemsApi.rename`, `libraryItemsApi.drafts`, `libraryItemsApi.createDraft`, `libraryItemsApi.saveDraft`, `libraryItemsApi.seal`, `libraryItemsApi.publish`, `libraryItemsApi.withdraw`, `libraryItemsApi.associate`, `libraryItemsApi.projectItems`, `libraryItemsApi.dissociate`, `libraryApi.drafts`, `adminTransferSponsor`, `listMySponsorProposals`, `listOrganizationSponsorProposals`, `acceptSponsorProposal`, `declineSponsorProposal` and `cancelSponsorProposal`, each followed by a word boundary, and for the path fragments `/v1/analysis/`, `sponsor-proposals` and `/v1/admin/organizations/` followed by `/sponsor`
- **THEN** it finds none
- **AND** the imported objects `platformApi`, `libraryItemsApi`, `libraryApi` and `apiClient` have none of the named members, and `frontend/src/analysis/archive.ts` does not exist
- **AND** the kept bindings `platformApi.reports`, `platformApi.resources`, `platformApi.resourceRevisions`, `libraryItemsApi.list`, `libraryItemsApi.versions`, `libraryItemsApi.content`, `libraryItemsApi.resolve`, `libraryApi.list`, `libraryApi.versions` and `libraryApi.content` are not reported

#### Scenario: A binding comes back
- **GIVEN** `frontend/src/api/client.ts` defining `listMySponsorProposals` again
- **WHEN** the test runs
- **THEN** it fails, naming the file and the binding

#### Scenario: Build without the bindings
- **GIVEN** this change's frontend sources
- **WHEN** `pnpm build` runs in `frontend/`
- **THEN** it succeeds, so no kept module imports a deleted binding or type

Evidence: `frontend/src/api/removedOperations.test.ts`

### Requirement: Organization settings offer only the caller as sponsor
`req~frontend-workspace-org-sponsor-self-only~1`
WHILE an OWNER who is not the current billing sponsor views the organization settings screen, the frontend SHALL offer the caller as the only choice of new sponsor.

Needs: impl, utest

#### Scenario: OWNER who is not the sponsor
- **GIVEN** bob, an OWNER of `acme`, which alice sponsors, and the platform accounts carol and dave
- **WHEN** bob opens the settings of `acme`
- **THEN** the "New sponsor" choices are "Keep alice" and "Me (bob)" only
- **AND** the screen shows no "Sponsor requests" section and no text saying that naming someone else sends them a request
- **AND** the frontend sends no request whose path contains `sponsor-proposals`

#### Scenario: Taking over
- **GIVEN** the same screen
- **WHEN** bob chooses "Me (bob)" and confirms
- **THEN** the frontend sends `PATCH /v1/organizations/acme` with `{"billing_sponsor_user_id": "<bob's id>"}` and no other field
- **AND** after a 200 answer the screen names bob as the current sponsor

#### Scenario: Caller already sponsors
- **GIVEN** bob, an OWNER who sponsors `acme`
- **WHEN** bob opens the settings of `acme`
- **THEN** the screen names bob as the current sponsor and offers no sponsor change control

Evidence: `frontend/src/pages/Organization/OrgSettings.test.tsx`

### Requirement: No sponsor requests in account screens
`req~frontend-workspace-no-sponsor-requests~1`
WHEN a signed-in user opens the account notifications screen or the notification menu, the frontend SHALL show no sponsor request and send no request whose path contains `sponsor-proposals`.

Needs: impl, utest

#### Scenario: Notifications screen
- **GIVEN** a signed-in user with 2 unread notifications
- **WHEN** the user opens `/app/account/notifications`
- **THEN** the screen lists the 2 notifications and has no "Sponsor requests for you" section
- **AND** no request whose path contains `sponsor-proposals` is sent

#### Scenario: Notification menu badge
- **GIVEN** the same user
- **WHEN** the header's notification menu renders
- **THEN** its badge shows 2 and its accessible name does not mention sponsor requests

Evidence: `frontend/src/pages/Account/AccountNotifications.test.tsx`; `frontend/src/components/NotificationDropdown/NotificationDropdown.test.tsx`
