# Triaje F821 (ruff, `src` + `tests`)

Origen: checks 1 y 2 (`ruff check --select F821`), 5 errores. Veredicto global: **5 DESCARTADOS**, ninguno es un bug real alcanzable.

Patrón común: los 5 son anotaciones `Mapped["X"]` / `Mapped[Optional["X"]]` entre comillas (con `from __future__ import annotations` en ambos ficheros). SQLAlchemy las resuelve por nombre en el registry declarativo al configurar los mappers, no por el espacio de nombres del módulo. El segundo argumento, `relationship("X")`, también es un string resuelto por el registry. Ruff no ve ese registry, de ahí el falso positivo.

Condición para que sea válido: `Blob`, `ArtifactVersion` y `ArtifactDraft` deben estar importados (registrados en `Base`) antes de configurar los mappers. Se cumple: `db/models.py:568-607` importa `platform_models` (incluye `Blob`) y `artifact_models` (incluye `ArtifactVersion` y `ArtifactDraft`) al final del módulo. Definiciones: `Blob` en `platform_models.py:595`, `ArtifactVersion` en `artifact_models.py:30`, `ArtifactDraft` en `artifact_models.py:51`.

| # | Nombre | Ubicación | Estado | Alcanzable en producción | Test que lo ejerce |
|---|--------|-----------|--------|--------------------------|--------------------|
| 1 | `Blob` | `db/artifact_models.py:42` | DESCARTADO | Solo como string de anotación y de `relationship`; resuelto por el registry | Indirecto: `tests/test_artifact_library.py` y otros cargan los modelos y configuran mappers |
| 2 | `ArtifactVersion` | `db/platform_models.py:455` | DESCARTADO | Igual | `test_artifact_library.py`, `test_seed_dev.py`, `test_v1_persistence.py` |
| 3 | `ArtifactDraft` | `db/platform_models.py:543` | DESCARTADO | Igual | `test_artifact_library.py` |
| 4 | `ArtifactVersion` | `db/platform_models.py:544` | DESCARTADO | Igual | Igual que 2 |
| 5 | `ArtifactVersion` | `db/platform_models.py:583` | DESCARTADO | Igual | Igual que 2 |

## Riesgo residual (no es F821)

`platform_models.py` referencia clases de `artifact_models.py` y este importa `utcnow` de aquel (`artifact_models.py:11`). La referencia es solo por string, así que no hay import circular. Si alguien importa `platform_models` sin pasar por `db.models`, `artifact_models` podría no estar registrado y fallaría `configure_mappers()` con `InvalidRequestError` (no con `NameError`). No he comprobado si `db/__init__.py` lo evita: importa `.models`, que sí registra ambos módulos. No he buscado imports directos de `platform_models` fuera del paquete.

## Arreglo mínimo propuesto (opcional, solo para silenciar el linter)

Elegir una de estas dos:

- En `artifact_models.py` y `platform_models.py`, añadir `if TYPE_CHECKING:` con el import de las clases referenciadas. El import de `platform_models` hacia `artifact_models` solo debe existir bajo `TYPE_CHECKING`, para no crear un ciclo en tiempo de ejecución.
- Configurar `per-file-ignores = {"src/openbinding_gateway/db/*_models.py" = ["F821"]}` en la configuración de ruff.

No se necesita ningún cambio funcional.

## Limitaciones

- No he podido ejecutar los tests (no hay check registrado para ello). La columna de tests sale de un grep de nombres en `tests/`, no de ejecución.
- No he consultado `git log` de los ficheros (no hay herramienta para ello en esta sesión).
