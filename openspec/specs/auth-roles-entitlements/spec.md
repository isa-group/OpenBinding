# auth-roles-entitlements Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

Identity and authority on the platform: accounts and sessions (`/v1/auth/*`), Universidad de Sevilla CAS sign-in,
API keys (`/v1/users/me/api-keys`), the two role sets (account role `USER`/`ADMIN`; organization role
`VIEWER < MEMBER < ADMIN < OWNER`), and plan entitlements read from the remote SPACE service through
`services/entitlements.py`. Sources: `docs/ACCOUNTS_AND_PLANS.md`, `docs/ACCESS_POLICY.md`.

## Requirements

### Requirement: Open registration on the default plan
WHEN a visitor registers, THE gateway SHALL create an active account on the catalogue's default free plan, store the e-mail lower-cased, never echo the password, and answer a taken identifier without saying which identifier was taken.

`req~auth-roles-entitlements-registration~1`

Evidence: `openbinding-gateway/tests/test_auth_endpoints.py`

#### Scenario: Taken e-mail
- **GIVEN** an account with e-mail `alice@example.org`
- **WHEN** someone registers another username with `Alice@Example.org`
- **THEN** the gateway refuses with a conflict that names neither the e-mail nor the username

### Requirement: Rotating refresh tokens
WHEN a refresh token is presented, THE gateway SHALL issue a new access/refresh pair and spend the presented token; IF a spent refresh token is presented again, THEN THE gateway SHALL refuse it and end every session of that user.

`req~auth-roles-entitlements-refresh-rotation~1`

Evidence: `openbinding-gateway/tests/test_auth_endpoints.py`

#### Scenario: Stolen refresh token replayed
- **GIVEN** a refresh token already exchanged by its legitimate holder
- **WHEN** an attacker presents it
- **THEN** the gateway refuses it and every session of the user ends

### Requirement: API keys shown once and stored hashed
WHEN an API key is created, THE gateway SHALL return the `obk_`-prefixed secret exactly once, store only its SHA-256 hash, and stop accepting it once revoked; a user SHALL NOT revoke another user's key.

`req~auth-roles-entitlements-api-key-secrecy~1`

Evidence: `openbinding-gateway/tests/test_api_keys.py`

#### Scenario: Listing keys after creation
- **GIVEN** a key created a minute ago
- **WHEN** its owner lists the keys
- **THEN** the list shows the prefix and permissions but not the secret

### Requirement: Key permissions never widen the role
WHEN a request is authenticated with an API key, THE gateway SHALL allow an action only if both the key's permissions and its user's role allow it.

`req~auth-roles-entitlements-key-and-role~1`

Evidence: `openbinding-gateway/tests/test_viewer_read_only.py`; `openbinding-gateway/tests/test_api_key_route_table.py`

#### Scenario: Executing key of a viewer
- **GIVEN** a VIEWER whose key has `engines:execute`
- **WHEN** the key launches a job in that organization
- **THEN** the gateway answers 403 `insufficient_role`

### Requirement: Plan bounds the number of API keys
IF creating an API key would exceed the plan's `apiKeys` limit (revoked keys excluded), THEN THE gateway SHALL answer 402 `quota_exceeded`.

`req~auth-roles-entitlements-api-key-quota~1`

Evidence: `openbinding-gateway/tests/test_api_keys.py::test_the_plan_bounds_how_many_keys_you_may_hold`; `openbinding-gateway/src/openbinding_gateway/routes/users.py`

#### Scenario: Second key on the basic plan
- **GIVEN** a basic-plan account with one active key and a limit of one
- **WHEN** it creates another key
- **THEN** the gateway answers 402 `quota_exceeded`

### Requirement: Organization roles and owner-only changes
THE gateway SHALL apply an organization role to the organization and its descendants, require ADMIN to manage members, and refuse with 403 `owner_role_requires_owner` any grant, change or removal of the OWNER role by a non-owner; IF a change would remove or demote the last OWNER, THEN THE gateway SHALL answer 409 `last_owner`.

`req~auth-roles-entitlements-org-roles~1`

Evidence: `openbinding-gateway/tests/test_b1_member_roles.py`

#### Scenario: Admin promotes a member to owner
- **GIVEN** an ADMIN of organization `acme`
- **WHEN** the admin sets bob's role to OWNER
- **THEN** the gateway answers 403 `owner_role_requires_owner` and nothing changes

### Requirement: Platform administrators get no tenant access
WHILE a platform administrator holds no role in a private organization, THE gateway SHALL give that administrator no access to the organization's projects, artifacts or audit.

`req~auth-roles-entitlements-admin-separation~1`

Evidence: `openbinding-gateway/tests/test_admin_security_separation.py`; `openbinding-gateway/tests/test_b1_member_roles.py`

#### Scenario: Admin opens a private project
- **GIVEN** a platform ADMIN who is not a member of `acme`
- **WHEN** the admin requests a private project of `acme`
- **THEN** the gateway answers as for a project that does not exist

### Requirement: CAS identities linked only explicitly
WHEN a Universidad de Sevilla CAS identity signs in, THE gateway SHALL never link it to an existing account by e-mail alone; WHEN a user links CAS explicitly, THE gateway SHALL assign the `RESEARCH` plan.

`req~auth-roles-entitlements-cas-linking~1`

Evidence: `openbinding-gateway/tests/test_cas_platform.py`

#### Scenario: CAS user with an existing e-mail
- **GIVEN** a local account `alice@us.es`
- **WHEN** a CAS sign-in arrives for `alice@us.es` without a link intent
- **THEN** the gateway does not attach the CAS identity to the local account

### Requirement: Entitlements from the plan service
WHEN a decision depends on the caller's plan, THE gateway SHALL read the capabilities only through the entitlement service, answer 403 `feature_not_entitled` for a feature the plan lacks, and answer 503 `pricing_unavailable` (never a refusal) when the plan cannot be read.

`req~auth-roles-entitlements-plan-reads~1`

Evidence: `openbinding-gateway/tests/test_entitlement_service.py`; `openbinding-gateway/tests/test_pricing_gate.py`

#### Scenario: SPACE unreachable during a launch
- **GIVEN** `SPACE_ENABLED=true` and SPACE not answering
- **WHEN** a member submits a job
- **THEN** the gateway answers 503 `pricing_unavailable` and creates no job

### Requirement: No metering
THE platform SHALL NOT meter, charge or count credits or compute units, and SHALL NOT run a local SPACE stack or local pricing.

`req~auth-roles-entitlements-no-metering~1`

Evidence: `openbinding-gateway/tests/test_architecture_layers.py`; `openbinding-gateway/tests/test_no_local_space.py`; `openbinding-gateway/tests/test_no_local_pricing.py`

#### Scenario: Reintroducing a metering module
- **GIVEN** a change that adds `openbinding_gateway/metering.py` and imports it
- **WHEN** the unit suite runs
- **THEN** the architecture test fails

## Out of scope

- Remote SPACE/SPHERE internals and their consoles.
- Visibility of projects and artifacts to non-members (`collaboration-artifacts`).

## TODO

- Open gate behaviour with `SPACE_ENABLED=false` (`docs/ACCOUNTS_AND_PLANS.md` "What the open gate grants").
- Password reset flow, account deletion and reassignment, admin audit events, notifications.
- Sponsorship proposals (`/v1/sponsor-proposals`) and sponsor quotas (402 `sponsor_quota_exceeded`, `storage_quota_exceeded`).
- Class B usage counters: decided as wanted (2026-10-14) but not applied until SPACE is measured.
