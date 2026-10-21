# QA final de integración (OpenBinding)

Base: tareas 0, 2A, 1B, 1A, 1C, 2B, compose, cleanup-1, 3A-1, 3A-2a, 3A-2b, 3C, 4A, H-X, H-Y.
Los 5 checks registrados se ejecutaron en orden, en esta sesión, vía `qa_run`. No se modificó código ni tests.

## Checks

| # | Check | Exit | Resultado literal resumido |
|---|-------|------|----------------------------|
| 0 | `uv sync --locked --extra test` | 0 | `sync-ok` |
| 1 | pytest del gateway (`--ignore=tests/integration tests`) | 0 | `1597 passed, 15 skipped, 2 xfailed, 13 warnings in 256.90s`. 0 failed, 0 errors. |
| 2 | ruff + alembic heads + wc + `git diff --check` | 0 | ruff `Found 68 errors.`; alembic `b4c5d6e7f8a9 (head)` (un único head); `diff-ok` |
| 3 | frontend `pnpm install --frozen-lockfile` + `pnpm test` | 0 | `Test Files 177 passed (177)`, `Tests 2486 passed (2486)` |
| 4 | pytest de contratos (arquitectura, bim-core, leases, settlement, launch, idempotencia, api-key routes, telemetría) | 0 | `353 passed, 4 warnings in 19.10s` |

### Ruff por categoría (68 errores)

Línea base original: 69. Línea base tras la primera integración: 66. Ahora: 68, es decir −1 frente a la base original y **+2 frente a la medida tras la primera integración**.

| Código | Regla | Nº |
|--------|-------|----|
| F401 | unused-import | 36 |
| F811 | redefined-while-unused | 16 |
| B905 | zip-without-explicit-strict | 5 |
| F821 | undefined-name | 5 |
| E741 | ambiguous-variable-name | 2 |
| F841 | unused-variable | 2 |
| B023 | function-uses-loop-variable | 1 |
| E402 | module-import-not-at-top-of-file | 1 |

La suma es 68. Los desgloses por categoría de las líneas base (66 y 69) no estaban disponibles en esta sesión. Por eso no puedo atribuir los +2 a una categoría concreta ni afirmar cuáles son nuevos. Hay 5 F821 (undefined-name), que pueden ser fallos reales en tiempo de ejecución y conviene revisarlos primero.

### Tamaño de módulos (salida de `wc -l`)

`routes/v1.py` 3311, `services/engines.py` 1220, `services/execution.py` 617, `services/snapshots.py` 349, `repositories/jobs.py` 68, `domain/entitlements.py` 66, `domain/idempotency.py` 27. Total 5665 (incluye los `__init__.py`).

## Tests saltados (15)

Por falta de PostgreSQL (10), la razón literal es "requires PostgreSQL: row locks and SKIP LOCKED are not exercised by SQLite" o "Row-lock concurrency requires PostgreSQL":
- `tests/concurrency/test_job_leases_pg.py`: 3 (líneas 56, 83, 101)
- `tests/concurrency/test_jobs_idempotency_pg.py`: 1 (línea 27)
- `tests/concurrency/test_study_cells_pg.py`: 2 (líneas 106, 139)
- `tests/concurrency/test_two_sessions_smoke.py`: 1 (línea 7)
- `tests/test_artifact_library.py`: 3 (línea 187, concurrencia con row-lock)

Por jar ausente (5): `tests/test_generator_routes.py` (líneas 174, 229, 296 ×2, 370). El jar del generador BIM legacy no está construido (`engines/bim-generator/target/bim-generator-0.1.0-SNAPSHOT.jar`; haría falta `mvn package`).

Total: 7 (concurrency) + 3 (artifact_library) + 5 (generator) = 15.

Los 2 xfailed no se listaron en la salida recortada (`tail -n 45`), así que no puedo nombrarlos.

## Fallos nuevos

Ninguno observado: 0 failed y 0 errors en la suite del gateway, el frontend y los tests de contratos. Los únicos puntos a vigilar son los +2 de ruff, sin atribuir, y los 5 F821.

Warnings relevantes, no son fallos:
- Deprecación de Starlette (`HTTP_422_UNPROCESSABLE_ENTITY`, `httpx`).
- `SAWarning: fully NULL primary key identity` en 4 tests de `tests/test_settlement_durability.py` (sweep/reconciler de study cells). Probablemente un `get` con PK nula en la ruta de resincronización; conviene revisarlo.

## No verificado

- **PostgreSQL**: los tests de concurrencia (`SKIP LOCKED`, row locks, leases, idempotencia concurrente, study cells) se saltaron. Todo lo demás corrió sobre SQLite. La corrección bajo concurrencia real no está demostrada.
- **Docker / compose**: no se levantó ni se validó nada de compose ni imágenes.
- **Integración con motores reales**: el jar del generador BIM legacy no está construido y no se ejecutó `tests/integration` (excluido por el check). Los motores externos no se ejercitaron.
- **E2E de navegador**: no se ejecutó ninguno. El frontend solo tiene resultados de tests unitarios/de componentes con `pnpm test`.
- Los 2 xfailed no se inspeccionaron.
- Las líneas base de ruff solo se compararon por total.
