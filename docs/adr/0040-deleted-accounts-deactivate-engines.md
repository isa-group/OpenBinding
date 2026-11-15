# 0040. A deleted account's federated engines are deactivated

- Status: accepted
- Date: 2026-11-14 (F0b, decision D29 of the F0b implementation plan)

## Context

Deleting an account pseudonymises it (D16): the user row stays with `deleted_at`, personal data is replaced, and
credentials, memberships and identities go. The account may have registered federated engines that runs reference.

## Decision

Pseudonymisation deactivates the account's engine registrations and keeps their engine and registration revisions
(`RESTRICT`). The deactivation notification is sent after pseudonymisation. A username that owns engine namespaces
stays reserved.

## Consequences

- Runs keep their provenance, and no new run selects an engine nobody answers for.
- A deleted administrator loses the administrator role, so the bootstrap can seed a new one.

Where: `routes/users.py`, `tests/test_account_pseudonymisation.py`.
