# Contributing

Thanks for contributing to OpenBinding.

## Branching model

- Default branches: `develop` and `main`.
- Always create new branches from `develop`.
- Open pull requests into `develop`.
- Admin will merge `develop` into `main` when appropriate.

## Workflow

1. Create a feature branch from `develop`:

   ```bash
   git checkout develop
   git pull
   git checkout -b feature/my-change
   ```

2. Make changes with tests and documentation updates as needed.

3. Push the branch and open a PR targeting `develop`.

4. Address review feedback and keep the branch up to date with `develop`. All PRs must pass CI checks before merging.

## Commit policy

- Each commit should represent one coherent, reviewable change.
- Use a Conventional Commit prefix: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, or `ci`.
- Write the subject in lowercase, in the imperative, without a final period; add a scope when it improves clarity.
- Keep generated artifacts, dependency updates, documentation, tests, and functional changes in separate commits when they can be reviewed independently.
- Do not mix unrelated changes, and include the relevant tests or documentation in the same commit as the behavior they describe.

## Expectations

- Keep changes focused and well tested.
- Update docs when behavior changes.
- Follow existing coding conventions and linting rules.
- Document the rationale for non-trivial changes in the PR description. If possible, create a small video demo of the change in action.
- Be responsive to review feedback and iterate on the PR until it meets the standards for merging. Each PR should be a self-contained unit of work that can be easily reviewed and understood.
- All PRs must be reviewed and approved by at least one other contributor before merging. This ensures code quality and knowledge sharing across the team.
