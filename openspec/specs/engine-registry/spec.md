# engine-registry Specification

Status: DRAFT for owner review (2026-10-21)
Baseline: `spec/platform-baseline` (from `integration/platform` @ 912648c) — reverse-engineered, spec-anchored.

## Purpose

Discovery of engines and registration of engine deployments, including federated third-party engines:
`GET /v1/engines[...]`, `POST /v1/engines`, the `/v1/engine-registrations` family (register, activate, deactivate,
publication request, approve, reject, credential, report, delete). Implemented by `services/engine_registry.py`,
`services/engines.py`, `services/discovery.py` and `v1/remote.py`.

## Requirements

### Requirement: Authenticated discovery
IF an anonymous caller lists, reads or executes engines, THEN THE gateway SHALL refuse with 401.

`req~engine-registry-authenticated-discovery~1`

Evidence: `openbinding-gateway/tests/test_v1_lifecycle_rbac.py::test_engine_discovery_and_execution_never_allow_anonymous_callers`; `docs/openapi.json`

#### Scenario: Anonymous engine list
- **GIVEN** no credentials
- **WHEN** a client calls `GET /v1/engines`
- **THEN** the gateway answers 401

### Requirement: Destination policy for deployments
WHEN a registration names a deployment endpoint, THE gateway SHALL accept it only over HTTPS (or trusted internal HTTP where allowed), without userinfo or fragment, and only if every address the name resolves to is public.

`req~engine-registry-destination-policy~2`

Evidence: `openbinding-gateway/tests/test_engine_registry_service.py`

#### Scenario: Name resolving to a private address
- **GIVEN** an endpoint `https://solver.example` that resolves to one public and one `10.0.0.5` address
- **WHEN** an engine author registers it
- **THEN** the gateway refuses the registration with a problem document

### Requirement: Pinned deployment connection
WHEN the gateway connects to a validated deployment endpoint, THE gateway SHALL pin the validated address for the connection and SHALL NOT follow redirects.

`req~engine-registry-pinned-connection~1`

Evidence: `openbinding-gateway/tests/test_v1_remote.py::test_remote_transport_pins_validated_address_against_dns_rebinding`; `openbinding-gateway/tests/test_engine_registry_service.py::test_a_redirect_from_the_deployment_is_not_followed`

#### Scenario: Deployment answers a redirect
- **GIVEN** a registered deployment that answers a redirect to another host
- **WHEN** the gateway calls it
- **THEN** the gateway does not request the redirect target

### Requirement: Idempotent immutable registration
WHEN the same identity is registered again with the same content digest, THE gateway SHALL return the stored registration; IF it is registered with different content, THEN THE gateway SHALL answer 409 `immutable_registration`.

`req~engine-registry-immutable-registration~1`

Evidence: `openbinding-gateway/tests/test_v1_platform_contracts.py::test_registration_lifecycle_targets_one_exact_immutable_revision`; `openbinding-gateway/tests/test_engine_registry_service.py`

#### Scenario: Re-registration with changed manifest
- **GIVEN** a registration `acme/solver@1.0.0` stored with digest D1
- **WHEN** the author posts the same identity with a manifest of digest D2
- **THEN** the gateway answers 409 `immutable_registration`

### Requirement: Conformance before activation
WHEN a registration is activated, submitted for publication or approved, THE gateway SHALL verify the deployment (pinned OpenAPI, authentication, health, deterministic solve probe), and on failure SHALL answer 409 `conformance_failed` with the checks and keep it inactive.

`req~engine-registry-conformance~1`

Evidence: `openbinding-gateway/tests/test_v1_platform_contracts.py::test_registration_conformance_*`

#### Scenario: Deployment answers a wrong result shape
- **GIVEN** a deployment whose probe answer violates the `BindingResult` schema
- **WHEN** the owner activates the registration
- **THEN** the gateway answers 409 `conformance_failed` and the registration stays inactive

### Requirement: Credentials never disclosed
THE gateway SHALL store deployment credentials encrypted at rest and SHALL never include a credential or its ciphertext in any response, report or message.

`req~engine-registry-credential-secrecy~2`

Evidence: `openbinding-gateway/tests/test_credential_store.py::test_the_stored_form_does_not_contain_the_secret`; `openbinding-gateway/tests/test_v1_lifecycle_rbac.py::test_engine_registration_secret_is_never_serialized`

#### Scenario: Reading a registration with a credential
- **GIVEN** a registration with a bearer credential set through `PUT .../credential`
- **WHEN** its owner reads the registration and its report
- **THEN** neither response contains the credential or its ciphertext

### Requirement: Embedded secrets refused
IF a registration document embeds a secret, THEN THE gateway SHALL refuse it without echoing the secret.

`req~engine-registry-embedded-secret~1`

Evidence: `openbinding-gateway/tests/test_engine_registry_service.py::test_registration_refuses_a_document_that_embeds_a_secret_without_echoing_it`

#### Scenario: Registration with a token inside
- **GIVEN** a registration document with a secret-like field such as `spec.extensions.apiToken`
- **WHEN** an engine author registers it
- **THEN** the gateway answers 422 `secret_in_document` without the secret

### Requirement: Private until approved
WHILE a registration is not approved for publication, THE gateway SHALL make it visible and usable only to its owner, answering others as if it did not exist.

`req~engine-registry-private-until-approved~1`

Evidence: `openbinding-gateway/tests/test_v1_lifecycle_rbac.py::test_registration_owner_controls_private_and_public_access`; `openbinding-gateway/tests/test_v1_lifecycle_rbac.py::test_approvals_and_publications_do_not_cross_revision_digests`

#### Scenario: Another user targets a private registration
- **GIVEN** an active, unpublished registration of alice
- **WHEN** bob submits a job naming it
- **THEN** the gateway answers 404

### Requirement: Federated engine quota
IF activating a registration would exceed the plan's limit of active federated engines, THEN THE gateway SHALL answer 402 with the quota and verify nothing.

`req~engine-registry-federated-quota~1`

Evidence: `openbinding-gateway/tests/test_federated_engines_limit.py`

#### Scenario: Second engine on a plan allowing one
- **GIVEN** a plan with `federatedEngines` = 1 and one active registration
- **WHEN** the owner activates a second
- **THEN** the gateway answers 402 and does not contact the deployment

## Out of scope

- The engine side of the protocol (`engine-protocol`).
- Moderation UI (`frontend-workspace`).

## TODO

- Mode compatibility checks between IR features and manifests (`tests/test_v1_platform_contracts.py::test_mode_compatibility_*`) as requirements.
- Bundled registrations pinning the whole deployment (`test_v1_job_guarantees.py`) and the `registration_changed` operational note.
- API-key engine allow-lists (exact `{namespace, name, version, digest}` references).
