## ADDED Requirements

### Requirement: Only the caller can become billing sponsor
`req~auth-roles-entitlements-sponsor-caller-only~1`
IF an OWNER of an organization sends a `PATCH /v1/organizations/{org}` request that names in `billing_sponsor_user_id` a user who is neither the caller nor the organization's current billing sponsor, THEN THE gateway SHALL refuse it with 422 and the problem code `sponsor_must_be_caller`, applying no field of the request.

Needs: impl, utest

#### Scenario: OWNER names another member
- **GIVEN** organization `acme` sponsored by alice, and bob, an OWNER of `acme`
- **WHEN** bob sends `PATCH /v1/organizations/acme` with `{"name": "Acme Lab", "billing_sponsor_user_id": "<carol's id>"}`
- **THEN** the gateway answers 422 with `code` `sponsor_must_be_caller`
- **AND** `acme` keeps the name it had and alice as sponsor, and no notification or audit event is written

#### Scenario: Unknown or inactive user named
- **GIVEN** bob, an OWNER of `acme`
- **WHEN** bob names a random UUID, and then the id of a deactivated account
- **THEN** both answers are 422 with `code` `sponsor_must_be_caller`, with identical bodies

#### Scenario: Retired request field
- **GIVEN** bob, an OWNER of `acme`
- **WHEN** bob sends `PATCH /v1/organizations/acme` with `{"billing_sponsor_user_id": "<bob's id>", "replace_pending_proposal": true}`
- **THEN** the gateway answers 422 with `code` `validation_error` and a diagnostic whose pointer is `/replace_pending_proposal`
- **AND** the sponsor does not change

#### Scenario: Contract published
- **GIVEN** the OpenAPI document the application generates
- **WHEN** the test reads the responses of `updateOrganization`
- **THEN** they hold no 202 response and no description naming `sponsor_proposal_pending`
- **AND** the 422 response describes `sponsor_must_be_caller`

Evidence: `openbinding-gateway/tests/test_org_sponsor_caller_only.py`

Nobody can make another person pay. Administrators assign RESEARCH or LAB in SPACE (ADR-0020 decision 3).

### Requirement: Taking over the sponsorship
`req~auth-roles-entitlements-sponsor-self-transfer~1`
WHEN an OWNER of an organization sends `PATCH /v1/organizations/{org}` naming themselves in `billing_sponsor_user_id` and their plan can take the organization and its subtree, THE gateway SHALL make them the billing sponsor of the organization in the same transaction and record `previous_sponsor_user_id` and `new_sponsor_user_id` on the `organization.updated` audit event.

Needs: impl, utest

#### Scenario: OWNER takes over
- **GIVEN** organization `acme` sponsored by alice, and bob, an OWNER of `acme` whose plan has room for `acme` and its projects
- **WHEN** bob sends `PATCH /v1/organizations/acme` with `{"billing_sponsor_user_id": "<bob's id>"}`
- **THEN** the gateway answers 200 with `billing_sponsor_user_id` equal to bob's id
- **AND** the audit event `organization.updated` carries `previous_sponsor_user_id` alice's id and `new_sponsor_user_id` bob's id

#### Scenario: Plan too small
- **GIVEN** bob, an OWNER of `acme`, whose plan cannot take the projects of `acme`
- **WHEN** bob names himself
- **THEN** the gateway answers 402 `sponsor_quota_exceeded` and alice stays sponsor

#### Scenario: ADMIN names themselves
- **GIVEN** dave, an ADMIN but not an OWNER of `acme`
- **WHEN** dave names himself
- **THEN** the gateway answers 403 and alice stays sponsor

#### Scenario: Naming the current sponsor
- **GIVEN** bob, an OWNER of `acme` sponsored by alice
- **WHEN** bob sends `PATCH /v1/organizations/acme` with `{"name": "Acme Lab", "billing_sponsor_user_id": "<alice's id>"}`
- **THEN** the gateway answers 200, the name is `Acme Lab` and alice stays sponsor

Evidence: `openbinding-gateway/tests/test_org_sponsor_caller_only.py`

### Requirement: Account lifecycle without sponsorship proposals
`req~auth-roles-entitlements-account-lifecycle-without-proposals~1`
WHEN an administrator deactivates an account or a user deletes their own account, THE gateway SHALL complete the operation without reading or writing sponsorship proposals.

Needs: impl, utest

#### Scenario: Deactivation on the new schema
- **GIVEN** a schema without the table `sponsor_proposals` (built from the application's ORM metadata after this change), and an active user erin
- **WHEN** a platform administrator sets erin's `is_active` to false
- **THEN** the gateway answers 200 and no audit event with action `organization.sponsor.cancelled` is written

#### Scenario: Deletion on the new schema
- **GIVEN** the same schema and a user frank who sponsors no organization
- **WHEN** frank deletes his account
- **THEN** the gateway answers as it did before this change for an account without sponsorships (204), and frank's account no longer exists

Evidence: `openbinding-gateway/tests/test_org_sponsor_caller_only.py`
