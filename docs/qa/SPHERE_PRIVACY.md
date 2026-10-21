# Privacidad anónima del pricing privado de SPHERE

Fecha de observación: 2026-10-13. Documento de evidencia: no se ejecutó nada al redactarlo y no se
modificó SPHERE ni SPACE ni se publicó nada.

## Método

- Herramienta `anonymous_http` del supervisor: solo `GET` y `HEAD` al origen oficial de SPHERE.
- Sin cookies, sin `Authorization`, sin API keys; sin seguir redirecciones.
- Ninguna llamada a SPACE. Ninguna escritura.
- Se compara un **control público** (`openbinding`, `private=false`, que debe dar 200) con el **pricing privado**
  de desarrollo (`openbinding-dev`, versión `0.1.0`, id `6acda0164b2b5b01c587c19a`, creado con `private=true`).
  El flag `private=true` por sí solo no es evidencia: lo que cuenta es lo que ve un llamante anónimo.
- Identificadores: la organización `openbinding` tiene id `6a9d1aea93628b97bbf639d2`.
- Las rutas que se usan como evidencia son solo las que dieron 200 para el control público.

## Peticiones y resultados

Rutas relativas al origen de SPHERE.

| # | Petición | Estado | Qué demuestra |
|---|---|---|---|
| 1 | `GET /api/v1/pricings?name=openbinding&limit=20` (control público) | 200 JSON; `total=1`; `openbinding` 0.1.4, `private=false`, organización `openbinding` | La ruta de listado funciona de forma anónima y devuelve lo público. |
| 2 | `GET /api/v1/pricings/6a9d1aea93628b97bbf639d2/openbinding` (control público) | 200; versión 0.1.4, `private=false`, yaml `/static/pricings/uploaded/openbinding/0.1.4.yaml` | La vista por organización y nombre sirve un pricing público. |
| 3 | `HEAD /static/pricings/uploaded/openbinding/0.1.4.yaml` (control público) | 200 `text/yaml` | El fichero estático público es accesible. |
| 4 | `GET /api/v1/pricings?name=openbinding-dev&limit=20` (privado) | 200 `{"total":0,"pricings":[]}` | El pricing privado **no aparece en el listado** anónimo. |
| 5 | `GET /api/v1/pricings/6a9d1aea93628b97bbf639d2/openbinding-dev` (privado) | 404 `Pricing not found` | La vista por nombre **no lo revela**; la respuesta tiene la misma forma que la de un nombre inexistente, mientras que el control (petición 2) da 200. |
| 6 | `HEAD /static/pricings/uploaded/openbinding-dev/0.1.0.yaml` (privado) | 403 `application/json` | El fichero estático **no se sirve**. |
| 7 | `HEAD /static/pricings/uploaded/openbinding/0.9.9.yaml` (fichero inexistente del mismo patrón) | 403 `application/json`, igual que la 6 | El 403 **no distingue existencia**: no filtra si el fichero privado existe, y no se sirve contenido. |

Rutas que **no** sirvieron como control (404 por owner o nombre incorrectos, no por privacidad) y que por eso no se
usan como evidencia:

- `/api/v1/pricings/openbinding/openbinding/0.4.1`
- `/api/v1/pricings/<id>/configuration-space`

## Conclusión

- **Verificada** (anónimo): privacidad en el **listado** (petición 4), en la **vista por nombre** (5) y en el
  **fichero estático** (6 y 7). Resultado 403/404 sin contenido, y sin diferencia observable entre un recurso privado
  y uno inexistente.
- **No verificada**: la ruta **por id** (`GET /pricings/:pricingId/configuration-space`). No hay una ruta de control
  que devuelva 200 para un pricing público (el control dio 404 en esa ruta), así que ningún resultado sobre el
  privado sería interpretable.
- El flag `private=true` por sí solo no era evidencia; la evidencia son las peticiones anteriores.
- Alcance: una sola observación, anónima, de una sola versión, con las rutas citadas. No se prueba nada sobre
  llamantes autenticados.
- No se modificó SPHERE y no se publicó nada.

## Hallazgo potencial por id (pendiente para el equipo de SPHERE)

Lectura de código de `source/sphere`, que es un **snapshot de referencia, no el despliegue**:

- `PricingRepository.findAll` filtra `private:false`.
- `findByNameAndOwner` no filtra por `private` en esa función. La privacidad en la vista por nombre depende de la
  ruta o la consulta del despliegue. El 404 anónimo observado (petición 5) es consistente con ello, pero **no prueba
  la rama de código**.
- `findById` no filtra `private`, y la ruta `GET /pricings/:pricingId/configuration-space` no tiene `isLoggedIn` en el
  snapshot.

Riesgo **potencial**: acceso anónimo por id a un pricing privado, si el id se conoce y el despliegue coincide con el
snapshot. **No comprobado** (ver conclusión). Queda como **hallazgo pendiente** para el equipo de SPHERE; no se
tocó nada.

## Contadores residuales del pricing privado de desarrollo

`openbinding-dev@0.1.0` se creó copiando la base `openbinding@0.1.5` con `--accept-usage-counters`
(ver [REMOTE_TOOLS.md](REMOTE_TOOLS.md)). Conserva **exactamente los 33 hallazgos de clase B** (usage counters:
`concurrentJobs`, `federatedTaskStarts`, `solverSeconds`, `studyRuns`, `taskStarts`) y **ningún hallazgo de clase A**
(sin `capacityUnits`, créditos ni CU).

Clasificación frente a la decisión humana (retirar moneda/CU/créditos y los contadores **mensuales** del sistema):

| Contador | Naturaleza | Frente a la decisión |
|---|---|---|
| `taskStarts` | allowance mensual | En conflicto con la retirada |
| `solverSeconds` | allowance mensual | En conflicto con la retirada |
| `federatedTaskStarts` | allowance mensual | En conflicto con la retirada |
| `studyRuns` | allowance mensual | En conflicto con la retirada |
| `concurrentJobs` | límite técnico de concurrencia | Compatible: la plataforma lo conserva |

Estado: **concesión histórica NO resuelta**. No se acepta como definitiva. No se crea otra versión mientras SPACE
esté en espera, y no se escribe en SPHERE ni en SPACE.

El código de OpenBinding ya no consume esos contadores. Según [ACCOUNTS_AND_PLANS.md](../ACCOUNTS_AND_PLANS.md),
«Nothing is metered or charged. There are no credits, compute units or consumption counters», y el único límite
sobre «cuánto a la vez» es un tope técnico de concurrencia que no depende del plan. La sección «How a limit
behaves» indica que cada límite es una entitlement del contrato de SPACE o ese tope técnico, y que ninguno es un
contador de consumo; todas las decisiones leen las capacidades en un único lugar, `services/entitlements.py`
(`EntitlementService`).

## Pendientes

1. **Humano**: decidir si se publica una versión sin allowances mensuales (sin `taskStarts`, `solverSeconds`,
   `federatedTaskStarts`, `studyRuns`; conservando `concurrentJobs`), una vez SPACE confirme su parser. Ver el
   rechazo de `createdAt` en «Primera aplicación real» de [REMOTE_TOOLS.md](REMOTE_TOOLS.md).
2. **Equipo de SPHERE**: revisar el hallazgo potencial por id (`findById` sin filtro `private` y
   `configuration-space` sin `isLoggedIn` en el snapshot) y, si procede, comprobar el despliegue con una ruta de
   control que devuelva 200 para un pricing público.
3. Repetir la verificación anónima si cambia el despliegue de SPHERE o se crea otra versión privada.
