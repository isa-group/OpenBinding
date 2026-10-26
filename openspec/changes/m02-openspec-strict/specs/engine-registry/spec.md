## MODIFIED Requirements

### Requirement: Pinned deployment connection
WHEN the gateway connects to a validated deployment endpoint, THE gateway SHALL pin the validated address for the connection and SHALL NOT follow redirects.

`req~engine-registry-pinned-connection~1`

Evidence: `openbinding-gateway/tests/test_v1_remote.py`; `openbinding-gateway/tests/test_engine_registry_service.py`

#### Scenario: Deployment answers a redirect
- **GIVEN** a registered deployment that answers a redirect to another host
- **WHEN** the gateway calls it
- **THEN** the gateway does not request the redirect target

### Requirement: Idempotent immutable registration
WHEN the same identity is registered again with the same content digest, THE gateway SHALL return the stored registration; IF it is registered with different content, THEN THE gateway SHALL answer 409 `immutable_registration`.

`req~engine-registry-immutable-registration~1`

Evidence: `openbinding-gateway/tests/test_v1_platform_contracts.py`; `openbinding-gateway/tests/test_engine_registry_service.py`

#### Scenario: Re-registration with changed manifest
- **GIVEN** a registration `acme/solver@1.0.0` stored with digest D1
- **WHEN** the author posts the same identity with a manifest of digest D2
- **THEN** the gateway answers 409 `immutable_registration`

### Requirement: Credentials never disclosed
THE gateway SHALL store deployment credentials encrypted at rest and SHALL never include a credential or its ciphertext in any response, report or message.

`req~engine-registry-credential-secrecy~2`

Evidence: `openbinding-gateway/tests/test_credential_store.py`; `openbinding-gateway/tests/test_v1_lifecycle_rbac.py`

#### Scenario: Reading a registration with a credential
- **GIVEN** a registration with a bearer credential set through `PUT .../credential`
- **WHEN** its owner reads the registration and its report
- **THEN** neither response contains the credential or its ciphertext

### Requirement: Private until approved
WHILE a registration is not approved for publication, THE gateway SHALL make it visible and usable only to its owner, answering others as if it did not exist.

`req~engine-registry-private-until-approved~1`

Evidence: `openbinding-gateway/tests/test_v1_lifecycle_rbac.py`

#### Scenario: Another user targets a private registration
- **GIVEN** an active, unpublished registration of alice
- **WHEN** bob submits a job naming it
- **THEN** the gateway answers 404
