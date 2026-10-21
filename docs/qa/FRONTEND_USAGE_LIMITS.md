# Frontend: límites agotados y límites desconocidos

Fecha: 2026-10-14 (tarea L). Complementa [USAGE_LIMITS.md](USAGE_LIMITS.md) y [USAGE_LIMITS_MATRIX.md](USAGE_LIMITS_MATRIX.md).
Todo está verificado con respuestas **sintéticas** (vitest); no se ha visto ninguna respuesta de un SPACE real y el
frontend no habla con SPACE. Los textos de la interfaz están en inglés, como el resto de la aplicación (no hay librería de
i18n: cada módulo de errores tiene su propia redacción, y estos siguen ese estilo).

## Principios

- Un límite es un **techo sobre algo medible** (tamaño del problema, jobs a la vez, celdas, segundos). Ningún texto dice
  «credits», «balance», «capacity units», «CU», «pay» ni «price»; hay un test que lo vigila
  (`pages/Jobs/jobErrors.test.ts`, `utils/limitRefusals.test.ts`).
- **Agotado, desconocido, tope del despliegue y no medido son cuatro cosas distintas** y cada una tiene su frase y su salida.
- El `403 binding_space_limit_unknown` **no** se muestra como error de permisos de API key. Nunca aparece «credential»,
  «permission» ni «API key» en ese mensaje.
- No se muestra ningún detalle sensible: no se repite el `detail` del gateway en estos casos (puede nombrar la causa
  interna), y el cliente solo conserva de la respuesta los campos que la interfaz usa (`api/limitNotice.ts`): `limit_id`,
  `state`, `source`, `unit`, `limit`, `used`, y de `binding_space` solo `log10`, `digits` y `cardinality` (≤ 40 dígitos).
  Nada de rutas, hosts ni nombres de tareas.
- Un plan mayor solo se ofrece cuando ayuda: **no** hay «See your plan / Compare plans» para un límite que fija el
  despliegue, ni para uno que el plan no declara o no se puede aplicar.

## Códigos y qué se muestra

| Respuesta | Qué dice la interfaz | `kind` | ¿Enlace al plan? |
|---|---|---|---|
| `402 instance_complexity_too_large` (`quota.source: plan`) | «Too big for your plan»: cuántas combinaciones tiene el problema (conteo exacto si es corto, si no `about 10^X` o solo los dígitos) y el techo del plan (`10⁹`). «Reduce the candidates or ask about a larger plan.» | `too-big` | sí |
| `403 binding_space_limit_unknown` | «Your plan doesn’t set a problem-size limit»: el plan no dice cuánto puede medir un problema; un plan mayor no lo arregla; «Contact the administrator.» | `limit-unknown` | **no** |
| `422 binding_space_over_technical_limit` | «Over this deployment’s size limit»: el despliegue limita el tamaño sea cual sea el plan; tamaño del problema y techo si vienen; «Reduce the candidates.» | `technical` | **no** |
| `422 binding_space_unmeasured` | «The problem’s size couldn’t be measured»: fallo del servicio, no del paquete; reintentar y, si persiste, informar con el código. | `unmeasured` | **no** |
| `503 pricing_misconfigured` | «Your plan can’t be applied»: un límite del plan falta o no se puede aplicar; no es culpa de la persona; «Contact the administrator.» No se repite el texto del gateway. | `misconfigured` | **no** |
| `429 concurrency_limit_exceeded` | «All your job slots are busy». `source: plan` → «Your plan lets you run N jobs at once.»; `source: technical` → «This deployment lets one account run N jobs at once, whatever its plan.»; sin `source` → el texto de siempre. Cuenta atrás con `Retry-After`. | `busy` | solo si `source ≠ technical` |
| `402 usage_limit_exceeded` | «Out of {contador}»: «You’ve used X of Y {contador}.» o «all your {contador}.» (sin prometer renovación). Solo existe con una fuente de contadores instalada. | `quota` | sí |
| `503 usage_limit_unknown` | «Your usage can’t be read right now»: reintentar en un momento; no es un problema de la cuenta. | `pricing` | no |
| `422 study_run_too_large` | «This run is over the deployment’s size limit»: el despliegue limita las celdas por run, sea cual sea el plan; reducir motores, ajustes o semillas. | `technical` | no |

El `402`, el `403`, el `422` y el `503` de un estudio (`POST …/studies/{s}/runs`) se rechazan **antes de crear nada**: no hay
run ni celdas. La interfaz lo cuenta como el rechazo de un job («A case is too big for your plan», «Nothing was started.»),
no como un run parcial.

## Dónde está

- `frontend/src/api/limitNotice.ts` (nuevo): tipos y lectura de `quota` y `binding_space`. Un `state` desconocido se lee como
  `unknown`, nunca como `exhausted`; se descarta todo lo que no tiene la forma esperada.
- `frontend/src/api/client.ts` `errorFor`: ahora **conserva** `notice` y `bindingSpace` en el `HttpError` (403, 422, 503…) y
  en el `QuotaError` (402), y `source`/`unit` del `429`. La doble forma del cable (`quota` dentro de `detail` en rutas de
  plataforma con estado distinto de 422; al nivel superior en rutas BIM y en cualquier 422) se resuelve con
  `detail?.quota ?? problem?.quota`, como antes.
- `frontend/src/utils/limitRefusals.ts` (nuevo): las frases, compartidas por trabajos, estudios y el workbench.
- `frontend/src/pages/Jobs/jobErrors.ts` (`refusalOf`) y `frontend/src/pages/Studies/studyErrors.ts` (`studyRefusal`): usan
  lo anterior; `Refusal` gana los `kind` `limit-unknown`, `technical`, `unmeasured`, `misconfigured` y el campo `source`.
- `frontend/src/pages/Jobs/parts.tsx` (`RefusalNotice`): decide cuándo se ofrece el enlace al plan (ver tabla).
- `frontend/src/pages/Workbench/workbenchModel.ts` y `CheckResult.tsx`: `/v1/validate` aplica el mismo límite, así que el
  workbench recibía el `403` como «This credential doesn’t include “validate instances”» y el `422` como «Not valid · 0
  problems». Ahora cada caso tiene su aviso; el `402` muestra el tamaño medido cuando viene (antes: «The server doesn’t
  report the measured size…», que se mantiene si no viene).
- `frontend/src/pages/Admin/adminModel.ts` y `AdminErrors.tsx`: significado de cada código nuevo y leyenda de la categoría
  `Quota` (incluye «límite desconocido»: es un fallo de configuración o del servicio, no del usuario).

## Qué no se hizo

- **Vista de uso de la cuenta** (`AccountUsage.tsx`): sigue mostrando `plan`, `features` y `capabilities`. Enseñar el techo
  efectivo de tamaño y su origen exige ampliar `GET /v1/users/me/usage` (contrato). No hecho.
- **«Capacity»** en `utils/limits.ts` (`LIMIT_GROUPS`): es el nombre de un grupo de la pricing publicada (límites que se
  liberan al terminar el trabajo: jobs, claves, motores) y se dejó. No es «unidades de capacidad» y no hay ninguna cantidad
  ni saldo asociado; si se quiere evitar la palabra, es un cambio de título que arrastra `Pricing.tsx` y sus tests.
- **e2e** (`frontend/e2e`): no se añadió ni se ejecutó ningún escenario de navegador. La cobertura es vitest (unidad y
  componentes del workbench).
- No hay cliente ni tipos generados desde `docs/openapi.json` en el frontend (los tipos son manuales), así que no hay
  nada que regenerar allí.

## Qué se probó

`pnpm test` (check 3). Los tests nuevos usan respuestas construidas a mano con la forma que emite el gateway; no dicen nada
de cómo responderá SPACE. Ver la lista en [USAGE_LIMITS.md](USAGE_LIMITS.md#verificación).
