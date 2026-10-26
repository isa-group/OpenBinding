## ADDED Requirements

### Requirement: Module skeleton packages
`req~gateway-architecture-skeleton~1`
The gateway package `openbinding_gateway` SHALL contain the subpackages `app`, `shared` and `modules`, each containing `__init__.py` holding only a docstring, with no existing module moved, no module outside them importing them and `docs/openapi.json` byte-identical.

Needs: impl, utest

#### Scenario: The three packages exist and are empty
- **GIVEN** `openbinding-gateway/src/openbinding_gateway/`
- **WHEN** the directories `app`, `shared` and `modules` are listed
- **THEN** each contains exactly one file, `__init__.py`
- **AND** parsing each `__init__.py` with `ast` yields exactly one statement, an expression holding a string constant (the docstring)

#### Scenario: Nothing imports the new packages
- **GIVEN** every `.py` file of `openbinding-gateway/src/openbinding_gateway/` outside `app/`, `shared/` and `modules/`
- **WHEN** its absolute and relative imports are resolved by AST
- **THEN** none resolves to `openbinding_gateway.app`, `openbinding_gateway.shared` or `openbinding_gateway.modules` or a submodule of them

#### Scenario: The OpenAPI snapshot is unchanged
- **GIVEN** the committed `docs/openapi.json`
- **WHEN** `uv run --locked python tools/dump_openapi.py --check` runs from `openbinding-gateway`
- **THEN** it exits 0

#### Scenario: The composition root keeps its entry point
- **GIVEN** the gateway image command `uvicorn openbinding_gateway.main:app`
- **WHEN** `openbinding_gateway.main` is imported
- **THEN** its attribute `app` is the FastAPI application and `openbinding_gateway.app` is a separate package

### Requirement: Module import contracts
`req~gateway-architecture-module-contracts~1`
The gateway SHALL declare in `openbinding-gateway/importlinter-modules.ini` the six module import contracts of design.md §2, with the module order of `docs/ARCHITECTURE.md` §4.2, while `openbinding-gateway/.importlinter` stays unchanged.

Needs: impl, utest

#### Scenario: Contract set
- **GIVEN** `openbinding-gateway/importlinter-modules.ini`
- **WHEN** it is read with `configparser`
- **THEN** section `importlinter` has `root_package = openbinding_gateway` and `include_external_packages = True`
- **AND** the contract sections are exactly `kernel`, `composition-root`, `no-legacy-http`, `module-layers`, `module-inside` and `pure-domain`
- **AND** `kernel` forbids `openbinding_gateway.modules`, `openbinding_gateway.app` and `openbinding_gateway.main` from source `openbinding_gateway.shared`
- **AND** `composition-root` forbids `openbinding_gateway.app` from sources `openbinding_gateway.modules` and `openbinding_gateway.shared`
- **AND** `no-legacy-http` forbids `openbinding_gateway.routes` and `openbinding_gateway.main` from source `openbinding_gateway.modules`
- **AND** `module-inside` is a `layers` contract over containers `openbinding_gateway.modules.*` with layers `adapters`, `application`, `domain`, top to bottom
- **AND** `pure-domain` forbids at least `fastapi`, `starlette`, `sqlalchemy` and `httpx` from source `openbinding_gateway.modules.*.domain`

#### Scenario: Module order of ARCHITECTURE 4.2
- **GIVEN** contract `module-layers`
- **WHEN** its `layers` are read top to bottom
- **THEN** they are `administration`, `publishing`, `laboratory`, `execution`, `engines | repository`, `language`, `collaboration`, `identity`, `plans`, each layer optional (in parentheses)
- **AND** its container is `openbinding_gateway.modules` and `exhaustive` is `True`

#### Scenario: Contracts hold on the current tree
- **GIVEN** the gateway source with an empty `modules/`
- **WHEN** `uv run --locked --extra test --group lint lint-imports --no-cache --config importlinter-modules.ini` runs from `openbinding-gateway`
- **THEN** it reports `Contracts: 6 kept, 0 broken` and exits 0

#### Scenario: A violation breaks a contract
- **GIVEN** a copy of the gateway source in which `modules/plans/domain/rules.py` imports `fastapi`
- **WHEN** the same `lint-imports` command runs on the copy
- **THEN** it reports `pure-domain` as broken and exits 1

#### Scenario: The legacy configuration is untouched
- **GIVEN** `openbinding-gateway/.importlinter`
- **WHEN** it is read with `configparser`
- **THEN** it declares exactly the three contracts `layers`, `no-routes` and `integrations`

### Requirement: Cross-module imports only through application
`req~gateway-architecture-application-only~1`
IF a gateway file outside `modules/<m>/`, other than `main.py` and the files of `app/`, imports `modules.<m>` or a submodule of it other than `modules.<m>.application`, THEN `tests/test_modules_cross_import.py` SHALL fail, naming the file, the line and the imported module.

Needs: utest

#### Scenario: Import of another module's domain
- **GIVEN** a source file `openbinding_gateway/modules/laboratory/application/runs.py` containing `from openbinding_gateway.modules.execution.domain import run`
- **WHEN** the cross-import rule checks it
- **THEN** it reports one violation naming the file, line 1 and `openbinding_gateway.modules.execution.domain`

#### Scenario: Import of another module's adapters or application internals
- **GIVEN** a legacy file `openbinding_gateway/services/probe.py` containing `from openbinding_gateway.modules.engines.adapters.http import router` and `from openbinding_gateway.modules.engines.application.use_cases import submit`
- **WHEN** the cross-import rule checks it
- **THEN** it reports two violations, one per line

#### Scenario: Import through the application public API
- **GIVEN** a source file `openbinding_gateway/modules/laboratory/application/runs.py` containing `from openbinding_gateway.modules.execution.application import submit_run` and `from openbinding_gateway.modules.execution import application`
- **WHEN** the cross-import rule checks it
- **THEN** it reports no violation

#### Scenario: Import of another module's package root
- **GIVEN** a source file `openbinding_gateway/modules/publishing/application/cite.py` containing `import openbinding_gateway.modules.repository`
- **WHEN** the cross-import rule checks it
- **THEN** it reports one violation naming `openbinding_gateway.modules.repository`

#### Scenario: Imports inside the same module
- **GIVEN** a source file `openbinding_gateway/modules/plans/adapters/http/routes.py` containing `from ...domain import plan` and `from openbinding_gateway.modules.plans.domain import plan`
- **WHEN** the cross-import rule checks it
- **THEN** it reports no violation

#### Scenario: The composition root is exempt
- **GIVEN** `openbinding_gateway/main.py` or `openbinding_gateway/app/routers.py` containing `from openbinding_gateway.modules.plans.adapters.http import router`
- **WHEN** the cross-import rule checks it
- **THEN** it reports no violation

#### Scenario: The real tree with no module
- **GIVEN** the gateway source with `modules/` absent or holding only `__init__.py`
- **WHEN** the rule runs over every `.py` file of `openbinding-gateway/src/openbinding_gateway/`
- **THEN** it reports no violation and the test passes
