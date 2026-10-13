# Análisis B5, B8, M4 e IR (cabeza `cd0e05f0`)

Fecha: 2026-10-13. Análisis, sin cambios de producción: no se tocó ningún fichero de `bim-toolchain/packages/*/src`, ningún
golden, ningún `xfail` existente. Lo único añadido son este documento y los tests de
`bim-toolchain/packages/bim-service/tests/analysis/`. Los informes `SECURITY_REVIEW.md` y `BIM_EQUIVALENCE.md` son
históricos: aquí se cita el código actual (`fichero:línea` de esta cabeza). Medido con CPython 3.11.2, en el entorno
bloqueado de `openbinding-gateway`, sin sockets ni uvicorn (ASGI en proceso).

## 0. Resumen por punto

| Punto | Estado en esta cabeza | Cambia respecto al informe histórico |
|---|---|---|
| B5 | **Abierto y peor de lo descrito.** La cuota por tenant se indexa por una cabecera que elige quien llama; además omitirla (o mandarla mal formada) desactiva la cuota, y el laboratorio no la envía nunca, así que la cuota por tenant está inerte para el tráfico del gateway. El techo global es independiente y se mantiene. | El informe decía "se evade rotando `X-BIM-Tenant`". Se añade: omitir/malformar la cabecera, "quemar" la etiqueta de otro, y que en el laboratorio no hay cabecera. |
| B8 | **Parcialmente atendido.** Las operaciones (compilar, evaluar, ZIP/XML) ya corren en un pool acotado de hilos con slots, `Retry-After` y presupuesto de tiempo. Siguen en el bucle de eventos: parseo/validación del cuerpo y render de la respuesta (≈40 ms por MB), y los hilos compiten por el GIL con el bucle (healthz pasa de 0,3 ms a 60-120 ms con 4 operaciones CPU). Un timeout no libera el slot. | El informe decía "no atendido". |
| M4 (a) | `bim-toolchain` ya **no** da verde sin corpus (job `golden-corpus` falla; `gate` exige todos), pero ese CI **nunca se ha ejecutado** y vive en un `.github/` anidado que GitHub ignora en este monorepo; ningún job del CI raíz compara las 82 contra los goldens. | El informe decía "sale 0 con aviso". Ya no es cierto en el fichero, sigue sin estar probado en ejecución. |
| IR (b) | Reproducido: 64/82 difieren. Las listas que cambian son **conjuntos** salvo `eligibility`, cuyo orden solo importa como **espacio de índices de motores con semilla** (no para la corrección). No existe arreglo que iguale los IR sin mover el digest semántico de esos 64. | Se precisa por lista y se descubre una segunda divergencia, independiente del orden (formato de números, §4.4). |

Decisión propuesta (§4.5): **(1) no existe en sentido estricto**; se recomienda una fase A compatible (clave de
equivalencia aditiva, sin mover goldens) y una fase B **MAJOR** con la ruta actual conservada detrás de una opción.

## 1. Qué se ejecutó

| Check registrado | Resultado |
|---|---|
| `0` (`uv sync --locked --extra test` del gateway) | `sync-ok` |
| `1` (pytest sobre `packages/bim-service/tests/analysis`, `diff --check`, sin `uv.lock`/`.venv` en el árbol) | última ejecución: **16 passed, 11 xfailed, 0 failed**, 75 s; `diff-ok`; ningún `uv.lock`/`.venv` en `git status`. |

Los 11 `xfail` son `strict=True` **y** `raises=OpenDefect`: solo se aceptan si fallan por la aserción del defecto, no por
un error del propio test. Cuando el defecto se arregle darán XPASS y la suite fallará hasta convertirlos en tests normales
(nunca en `skip`). Los tests de IR necesitan el corpus (`BIM_CORPUS_ROOT`, por defecto la raíz del monorepo): sin él se
saltan con motivo y con `BIM_REQUIRE_CORPUS=1` fallan (mismo convenio que `test_baseline_equivalence.py`).

## 2. B5: cuota por tenant en `bim-service`

### 2.1 Hechos (código actual)

* **Quién fija la cabecera.** Quien llama. `ContextMiddleware` la lee y la valida solo por forma
  (`middleware.py:41`, `:77-82`: `_TENANT = [A-Za-z0-9][A-Za-z0-9._:@-]{0,127}`; si no encaja, `tenant = None`). La
  autenticación (`auth.py:41-55`) devuelve un booleano: el token **no se asocia a ninguna identidad**.
* **Quién la usa.** `Gate._take_tenant` (`runtime.py:33-46`): `if tenant is None or limit == 0: return`, es decir,
  sin cabecera, con cabecera mal formada o con límite 0 **no hay cuota**. `settings.py:41`: por defecto 2 por tenant sobre
  4 slots (`:39`).
* **Quién la envía.** `HttpBim` envía **una** etiqueta fija, la de su constructor (`bim_client/http.py:79`, `:127-128`); ninguna
  llamada admite `tenant` ni cabeceras (`_headers`, `http.py:122-133`: solo `Accept`, `Authorization`, `X-BIM-Tenant`, y
  `traceparent` si se pasó un callable). El gateway la construye con `settings.bim_tenant` (`integrations/bim.py:94-101`,
  `core/settings.py:121-123`), es decir, **no reenvía cabeceras del usuario final**; no pasa `traceparent`.
* **En el laboratorio no hay etiqueta.** `BIM_TENANT` no aparece en `compose.lab.json` ni en `docker-compose.yml`
  (el servicio `bim-service` está en `compose.lab.json:126-160`; el entorno del gateway en `:204-208`). Resultado: el
  gateway manda sin cabecera, `tenant = None` y la cuota por tenant **no se aplica nunca** al tráfico real.
* **Techo global independiente.** Semáforo propio (`runtime.py:25`, `:58-69`) y contador por tenant en otro diccionario
  (`:27`); el pool tiene el mismo tamaño que el semáforo (`:28`). Un fallo al tomar el slot libera la cuota del tenant
  (`:81-84`).

### 2.2 Respuestas

* **¿Puede un cliente autenticado suplantar otro tenant o evitar su cuota?** Sí, de tres maneras, todas demostradas
  (`test_analysis_b5_tenant_identity.py`): (i) otra etiqueta por petición da una cuota nueva
  (`test_rotating_the_tenant_header_does_not_buy_a_fresh_share`, xfail); (ii) omitir la cabecera o mandarla mal formada
  no tiene cuota (`test_omitting_the_tenant_header_does_not_skip_the_share[omitted|malformed]`, xfail); (iii) usar la
  etiqueta de otro agota *su* cuota (`test_a_caller_can_burn_the_share_of_a_tenant_label_it_does_not_own`, pasa hoy:
  con una etiqueta y otro token, la petición de la víctima recibe 429).
* **¿Hay fuga de datos?** No: el servicio no tiene estado ni datos por tenant y el resultado no depende de la etiqueta
  (`test_the_tenant_header_never_changes_an_answer`, pasa; `SERVICE.md:22-23`, `:209-213`). El daño es de cuota, de
  atribución en logs (`middleware.py:121-129` registra la etiqueta no verificada) y de denegación a otra etiqueta.
* **¿Sigue el límite global independiente?** Sí, y se fija con un test que pasa
  (`test_the_global_ceiling_holds_whatever_tenant_each_request_claims`: 10 etiquetas, 2 slots, nunca más de 2
  operaciones, el resto 503).

### 2.3 Riesgo real vs hipotético

| Riesgo | Clase | Por qué |
|---|---|---|
| Un único llamador con token válido evade la cuota por tenant | **Real, demostrado** | tests xfail (i) y (ii); el techo global lo acota |
| La cuota por tenant está inerte en el laboratorio | **Real, por lectura de configuración** | no hay `BIM_TENANT` en los compose; no se probó contra el stack levantado |
| Quemar la etiqueta de otro | **Real** pero hoy sin efecto práctico (un solo token compartido) | pasa a importar en cuanto haya varios llamadores |
| Un usuario final del gateway fija la etiqueta | **No ocurre hoy** | el gateway no reenvía cabeceras (`http.py:122-133`); lo sostiene un test que pasa (`test_the_sdk_sends_the_one_tenant_it_was_built_with_and_forwards_no_other_header`) |
| Que el techo global falle por rotar etiquetas | **Descartado** | test que pasa |

### 2.4 Diseño: cuota por identidad autenticada

1. **Fichero de tokens con identidad.** Una línea es `token` (formato actual) o `tenant<espacios>token`. El formato nuevo
   es retrocompatible: hoy una línea con espacio es error (`auth.py:79`, caracteres 33-126), así que ningún fichero
   válido cambia de significado. Las líneas sin etiqueta pertenecen al tenant `default`. `tenant` cumple el mismo patrón
   que `_TENANT` (`middleware.py:41`, moverlo a un sitio común).
2. **Reglas del fichero** (en `read_tokens`, `auth.py:61-88`): hasta **2 tokens por tenant** (rotación), tenants ≤ 64,
   un token repetido en cualquier tenant es error (ambigüedad), una etiqueta mal formada es error, y ningún mensaje de
   error incluye un token.
3. **Identificar sin early-exit.** `Authenticator.identify(header) -> Principal | None` calcula el digest una vez y lo
   compara con **todos** los digests almacenados con `hmac.compare_digest`, quedándose con el tenant del que coincida
   (mismo patrón que `auth.py:51-55`). `authorize()` se conserva como envoltorio booleano.
4. **El tenant del `Principal` es la clave de la cuota.** `AuthMiddleware` lo escribe en `scope["state"]["tenant"]`
   (`middleware.py:137-148`); `ContextMiddleware` deja de derivar `state["tenant"]` de la cabecera y solo guarda el valor
   reclamado (`state["claimed_tenant"]`) para el log, que pasa a registrar `tenant=<identidad>`. La cabecera
   `X-BIM-Tenant` se acepta y se **ignora** para la cuota; si difiere de la identidad se registra un aviso con tasa
   limitada. Modo anónimo de desarrollo (`auth.py:97-102`): identidad fija `anonymous`, sin confiar en la cabecera.
5. **Cuota efectiva.** El límite por tenant solo se aplica si hay **≥ 2 tenants** configurados o si se fija
   explícitamente. Motivo: con un único tenant (el laboratorio: un token), el límite por defecto de 2 sobre 4 slots
   (`settings.py:41`) pasaría a **limitar a la mitad todo el tráfico**, hoy no limitado por estar inerte. Eso es una
   regresión de capacidad que el contrato debe evitar sin subir ningún límite del laboratorio.
6. **Techo global intacto**: `_slots`, `acquire_timeout_ms`, `operation_timeout_seconds` no cambian.

### 2.5 Frontera de confianza

| Salto | Quién autentica | Qué cruza | Regla |
|---|---|---|---|
| Usuario final → gateway | gateway (sesión/API key, roles) | cabeceras del usuario | el gateway las consume y **no las reenvía** |
| Gateway/worker → `bim-service` | **solo el servicio**, por token del fichero | `Authorization` propio; `X-BIM-Tenant` informativo | la identidad es el tenant del token; la cabecera nunca decide |
| Fairness por usuario/organización | el gateway (`MAX_CONCURRENT_JOBS_PER_USER`, `core/settings.py:98`) | — | `bim-service` limita por **llamador desplegado**, no por usuario; si se quisiera por organización haría falta un token por organización o una aserción firmada (descartado: más superficie) |

El SDK conserva `tenant=` por compatibilidad (etiqueta de log) y su docstring (`http.py:46-47`, `CLIENT.md:136`) debe
decir que **no** decide la cuota. `bim-service` no está publicado por nginx ni por puertos en el laboratorio
(`compose.lab.json:126-160` no tiene `ports`); no se comprobó el despliegue Kubernetes.

### 2.6 Rotación de dos tokens

Hoy (`BIM_LOAD.md`, `test_rotation_and_saturation.py:41-54`): el fichero se lee **solo al arrancar**; retirar un token
exige reinicio. Con identidad, el procedimiento es: (1) añadir la línea nueva del mismo tenant (dos líneas), reiniciar;
(2) el cliente cambia su fichero (`HttpBim._token` relee por mtime, `http.py:106-120`, y toma la **primera** línea);
(3) quitar la línea vieja, reiniciar. Ambos tokens de un tenant **comparten un solo contador** (es el test xfail
`test_the_two_tokens_of_a_rotation_share_one_count`). Mejora opcional, fuera del contrato mínimo: recarga por mtime/SIGHUP
(si se hace hay que reescribir `test_retiring_the_old_token_takes_effect_on_restart_only`).

### 2.7 Tests de suplantación y rotación propuestos

Los cuatro xfail actuales pasan a ser tests normales con la implementación. El resto, a escribir (todos sobre
`bim-service/tests`, salvo el último):

| Id | Dado / Cuando / Entonces |
|---|---|
| S1 | token del tenant A + cabecera B → se cuenta en A (429 al pasar el límite de A; B intacto) |
| S2 | sin cabecera o con cabecera mal formada → misma cuota que con la cabecera correcta |
| S3 | tenant A al límite no produce 429 a B con su propio token (aislamiento) |
| S4 | un token ajeno que reclama la etiqueta de A no consume la cuota de A (sustituye al test "quemar") |
| S5 | el techo global se mantiene con N tenants cuya suma de cuotas supera los slots (503 tras `acquire_timeout_ms`) |
| S6 | fichero: línea sin etiqueta → `default`; `tenant token` válido; etiqueta mal formada, token repetido entre tenants, 3 tokens para un tenant, 65 tenants → `ServiceConfigError` sin el token en el mensaje |
| S7 | un solo tenant configurado → el límite por defecto no se aplica; con `MAX_CONCURRENCY_PER_TENANT` explícito, sí |
| S8 | el log registra la identidad y nunca el token; con cabecera discrepante, un aviso (con tasa limitada) |
| R1 | old y new del mismo tenant se aceptan y comparten contador |
| R2 | el orden de las líneas no importa (extiende `test_swapping_the_order_in_the_file_changes_nothing`) |
| R3 | tras retirar el viejo y reiniciar, el viejo da el mismo 401 que un token inventado (extiende `test_a_retired_token_is_indistinguishable_from_any_wrong_token`) |
| R4 | `compare_digest` se llama una vez por token almacenado, sea cual sea el resultado (extiende el test del espía) |
| R5 | `HttpBim` con `token_file` de formato `tenant token` usa solo el token y relee tras cambiar mtime |
| G1 (gateway) | una petición de usuario con `X-BIM-Tenant` hostil no llega a `bim-service` (transporte capturado sobre `build_bim`) |

### 2.8 Contratos de implementación (B5)

| Id | Dueño (ficheros) | Hecho cuando | Compatibilidad |
|---|---|---|---|
| B5-S | `bim-service/src/bim_service/auth.py`, `middleware.py`, `settings.py`, `runtime.py` (solo nombres), `docs/SERVICE.md` | S1-S8 y R1-R4 pasan; los 4 xfail de `test_analysis_b5_tenant_identity.py` quedan como tests normales (sin `skip`); migrados los tests que distinguían tenants por cabecera (`test_service_limits.py:203-241` y los que usen tenant en `test_rotation_and_saturation.py`, no listados uno a uno) | MINOR (formato aditivo; la cabecera pasa a informativa, ya documentada como "nunca para autorización") |
| B5-C | `bim-client/src/bim_client/http.py`, `docs/CLIENT.md` | R5; docstring de `tenant` | PATCH/MINOR |
| B5-G | `openbinding-gateway/src/openbinding_gateway/integrations/bim.py`, `core/settings.py` (comentario de `bim_tenant`), compose del laboratorio (fichero de tokens con etiqueta opcional) | G1; ningún límite de CPU/memoria/pids tocado | sin cambio de API |
| B5-D | `bim-toolchain/contracts/openapi/bim-service.v1.json`, `tools/consumer_fixtures.py` | `python tools/dump_service_openapi.py --check` y `consumer_fixtures.py --check` limpios | — |

Checks que la tarea de implementación debe tener **registrados** (hoy solo existen los dos de esta tarea): suites
completas de `bim-service` y `bim-client`, las dos herramientas `--check` de arriba y el check 1 de esta tarea.

## 3. B8: trabajo costoso en el bucle de eventos

### 3.1 Qué corre dónde

| Trabajo | Dónde | Evidencia |
|---|---|---|
| `compile_package`, `validate_package` (ZIP, JSON, XML, compilación) | **hilo** `bim-op` | `app.py:142-162` → `_run` → `Gate.run` (`runtime.py:77-99`), `operations.py:139-160`; `test_operations_run_in_the_worker_pool_and_not_in_the_event_loop` (pasa) |
| `evaluate`, `reevaluate`, `neighborhood`, `compatibility`, `optimization`, `validate_*`, XML | **hilo** | `app.py:171-283`; el pool tiene `max_concurrency` hilos (`runtime.py:28`) |
| Lectura del cuerpo y límite de tamaño | bucle (barato) | `middleware.py:151-214`, `await request.body()` en `app.py:144` |
| **Decodificar el paquete** (`json.loads` de hasta 32 MiB, pydantic, base64, hasta 64 recursos) | **bucle** | `wire.py:120-154`, llamado en `app.py:144` y `:159` |
| **Parseo + validación de los modelos JSON** (incluido `_finite`, recorrido Python de todo el IR) | **bucle** | firmas `body: EvaluateRequest…` en `app.py:171-283`, `models.py:15-18`, `protocol.py:112-124` |
| **Render de la respuesta** (`json.dumps`) | **bucle** | `JSONResponse(result)` en `app.py:99` |
| base64 de XML | bucle (rápido) | `app.py:271`, `:282` |
| descriptores (`capabilities`, `profiles`…) | bucle, cacheados | `operations.py:299-355` (`schema()` relee y parsea el fichero cada vez, `:350`, sin medir) |

`bim-core` no tiene presupuesto de tiempo para compilar ni evaluar; solo `neighborhood` lo tiene y es cooperativo
(`neighborhood.py:77`, `:101`, y su docstring `:72-74`).

### 3.2 Cómo funcionan los slots y timeouts existentes (lectura)

* Slot: `BoundedSemaphore` con `acquire(blocking=False)` en bucle con `asyncio.sleep(≤10 ms)` hasta `acquire_timeout_ms`
  (`runtime.py:58-69`), así que **esperar un slot no bloquea el bucle**; vencido el plazo, 503 con `Retry-After`.
* Cuota por tenant: antes del slot (`:79-84`); el fallo libera.
* Timeout de operación: `asyncio.wait(..., timeout)` (`:92-98`). **No cancela el hilo**: el 503 `operation_timeout` sale,
  pero el slot y la cuota se liberan en `_finish` cuando el hilo termina (`:71-75`). Un hilo cancelado por desconexión del
  cliente se comporta igual. Está documentado (`runtime.py:7-8`, `SERVICE.md:27-28`) y probado (`BIM_LOAD.md`), y ahora
  fijado como defecto con `test_a_timed_out_operation_gives_its_slot_back` (xfail).
* Consecuencia: N operaciones atascadas ocupan N slots **sin límite de tiempo real**; con `max_concurrency=4` basta
  con 4 entradas patológicas. No hay medición de un peor caso real de compilación (§6).

### 3.3 Mediciones (sintéticas, locales, ASGI en proceso; las cifras varían entre ejecuciones)

| Escenario | Resultado |
|---|---|
| `/healthz` sin carga | mediana 0,3 ms |
| `/healthz` con 4 operaciones **CPU Python** en el pool | mediana **60 / 94 / 118 ms** (tres ejecuciones), p95 ≈ 180-190 ms, máximo 233-1078 ms; retraso del bucle p95 ≈ 180 ms. (El cliente comparte bucle con el servicio, lo que lo infla; es orden de magnitud, no latencia sobre sockets.) |
| `/healthz` con 4 operaciones **bloqueadas** (sin CPU) | < 250 ms en todas las muestras (test que pasa): el pool descarga el trabajo; lo que daña es el GIL, no la ausencia de `run_in_executor` |
| Cuerpo JSON de 4,7 / 14,2 / 28,6 MB a `/evaluate` | bucle parado **194-203 / 593-599 / 1146-1153 ms** (≈ 40 ms por MB), antes de cualquier slot o cuota |
| Respuesta de 20 MB | bucle parado ≈ **306 ms** en el `json.dumps` |
| Memoria previa al slot (`tracemalloc`) | `/compile` con cuerpo de 8,4 MB: pico 31,9 MB (**3,8×**); `/evaluate` con 7,1 MB de objetos pequeños: pico 55,9 MB (**7,9×**) |
| `sys.setswitchinterval` 5 ms → 1 ms → 0,5 ms → 0,1 ms con la misma carga | mediana de healthz 94-118 → 21-34 → 38 → **3,6-6,4 ms**; trabajo de los hilos por segundo a 0,1 ms ≈ −17 % respecto a 5 ms en una ejecución (16,4 k frente a 19,9 k; ruidoso, no repetido) |

Extrapolación (no medida a ese tamaño): un cuerpo de 32 MiB (`settings.py:37`) costaría ≈ 130 MiB (`/compile`) o ≈ 250 MiB
(`/evaluate`) **por petición en vuelo**, frente a `mem_limit: 256m` del contenedor (`compose.lab.json:146`). Como el
cuerpo se decodifica **antes** de pedir slot (`app.py:144` frente a `runtime.py:79`), N peticiones esperando cuestan N
cuerpos aunque solo `max_concurrency` puedan ejecutar (`test_no_body_is_decoded_for_a_request_that_finds_no_free_slot`,
xfail: 6 decodificaciones para 2 slots).

### 3.4 Riesgo real vs hipotético

| Riesgo | Clase |
|---|---|
| Parada del bucle ∝ tamaño del cuerpo (hasta ≈ 1,2 s con un cuerpo bajo el límite), solo para quien tiene token | **Real, medido** (3 xfail: decodificación, validación, parada medida) |
| Degradación de healthz/latencia bajo carga CPU por el GIL | **Real, medido**. No llega a matar el servicio: el healthcheck del laboratorio tiene `timeout: 3s` (`compose.lab.json:149-159`) y el p95 medido es ≈ 0,2 s |
| Un hilo vencido retiene su slot sin límite | **Real por diseño** (xfail + `runtime.py:7-8`); que una entrada real lo provoque es **hipotético** (no se midió ningún peor caso) |
| OOM por varias peticiones grandes a la vez | **Plausible por aritmética**, no medido en contenedor |
| `close()` no espera a hilos vivos (`runtime.py:101-102`) pero los hilos del pool bloquean la salida del intérprete | **Hipotético**, no probado (parada lenta ante SIGTERM) |
| El bucle se bloquea por esperar un slot | **Descartado** (lectura de `runtime.py:58-69`) |

### 3.5 Propuesta: ejecución acotada, sin subir los límites del laboratorio

Orden de menor a mayor coste; cada paso es independiente y conserva el modo actual detrás de una opción.

1. **Admisión antes de leer y trabajo completo en el pool.** (a) Presupuesto de bytes en vuelo
   (`BIM_SERVICE_MAX_INFLIGHT_BODY_BYTES`): se reserva `Content-Length` (o `max_body_bytes` si va por trozos) antes de
   leer; sin presupuesto, 503 con `Retry-After` y `Connection: close`, como ya hace el 413 (`middleware.py:156-168`). La
   cifra por defecto sale de `(mem_limit − RSS base) / 8` y **no se puede fijar sin medir** (contrato B8-0). (b) El
   handler lee los bytes y pasa **bytes** al hilo; el hilo hace decodificación + validación + operación + `json.dumps` y
   devuelve bytes (`Response(content=…)`). El bucle solo mueve bytes. Los modelos siguen declarados en OpenAPI por
   `openapi_extra`, como ya hace `_PACKAGE_BODY` (`app.py:69-89`).
2. **Intervalo de cambio del GIL** (`sys.setswitchinterval(1e-4)` en `create_app`): medido −94 % en la mediana de healthz;
   coste de rendimiento no establecido (≈ −17 % en una ejecución). Reversible y tras opción.
3. **Procesos con tamaño fijo, solo si 1-2 no bastan.** `max_concurrency` procesos worker preimportados (`spawn` o
   `forkserver`; nunca `fork` desde un proceso con bucle e hilos), uno por slot, **sin cola**: la espera sigue siendo el
   `acquire` actual. Entrada y salida son bytes por pipe. **Timeout y desconexión matan el proceso** (`SIGKILL`) y se
   repone otro con límite de tasa; el slot se devuelve al matar, no al terminar el cálculo. Tamaño del pool =
   `min(max_concurrency, ⌊(mem_limit − RSS base) / RSS worker⌋)`; con `mem_limit: 256m` y 4 workers que importan
   `bim_core` (jsonschema, lxml) es probable que no quepa: **RSS de worker no medido**. Un zygote precalentado
   reduciría el coste real por copy-on-write, tampoco medido. Opción `BIM_SERVICE_EXECUTOR=thread|process`, por defecto
   `thread` (ruta actual).
4. Sin cambios de `cpus: 1.5`, `mem_limit: 256m`, `pids_limit: 256` (`compose.lab.json:146-148`) ni de `max_concurrency`,
   `operation_timeout_seconds` o `max_body_bytes`.

### 3.6 Pruebas de responsiveness, saturación, cancelación y memoria

Ya hay (en `bim-service/tests`, citadas por `BIM_LOAD.md`): saturación con 503 y recuperación, cuota, slot devuelto al
fallar/cancelar, límite de cuerpo en streaming, memoria acotada del cuerpo. Añadidas aquí (`tests/analysis/`): las de §3.3
y los xfail de §3.4. A escribir en la implementación:

| Id | Prueba | Criterio |
|---|---|---|
| T1 | healthz con N compilaciones CPU (N = slots) en modo proceso | p95 < 50 ms y máximo < 250 ms |
| T2 | 2N peticiones, N slots | a lo sumo N workers vivos en todo momento (contar procesos hijos), el resto 503 en ≤ `acquire_timeout_ms` + margen |
| T3 | timeout de operación | 503 `operation_timeout`; el proceso ya no existe (`os.kill(pid, 0)` → `ProcessLookupError`); el slot vuelve en < 1 s (el xfail `test_a_timed_out_operation_gives_its_slot_back` pasa) |
| T4 | desconexión del cliente a mitad | igual que T3 |
| T5 | 50 timeouts seguidos | número de procesos hijos ≤ N + zygote; sin tormenta de reposición (tasa limitada) |
| T6 | cuerpo > presupuesto de bytes en vuelo | 503 antes de leer; memoria del proceso plana |
| T7 | los 3 xfail de decodificación/validación/parada pasan sin tocar sus aserciones | — |
| T8 | modo `thread` por defecto: suite actual sin cambios | — |

### 3.7 Contratos de implementación (B8)

| Id | Dueño (ficheros) | Hecho cuando |
|---|---|---|
| B8-0 | tarea de medición (documento nuevo en `docs/qa/`) | RSS en reposo y con 1/4/16/32 MiB, y RSS de un worker preimportado, medidos **en el contenedor** del laboratorio; fija el presupuesto y el tamaño de pool |
| B8-1 | `bim_service/app.py`, `wire.py`, `runtime.py`, `middleware.py`, `settings.py`, `docs/SERVICE.md` | xfail de decodificación, validación, parada, "sin slot no se decodifica" pasan; T6, T8 |
| B8-2 | `bim_service/app.py` (`create_app`), `settings.py` | `test_a_shorter_switch_interval_keeps_healthz_fast_under_the_same_cpu_load` sigue pasando con el valor configurado; medida de rendimiento repetida ≥ 5 veces |
| B8-3 | `bim_service/runtime.py` (+ módulo nuevo de workers), `settings.py` | T1-T5; xfail del GIL y del timeout pasan en modo `process`; modo `thread` intacto |

Checks a registrar: suite de `bim-service`, check 1 de esta tarea, y la medición B8-0 en el laboratorio.

## 4. M4 e IR

### 4.1 (a) Estado real de la equivalencia de 82 paquetes y del CI

* **Reproducido ahora** (check 1): 82 paquetes; 64 compilan a otro IR desde `to_zip()` que desde el directorio
  (`test_64_of_the_82_packages_compile_to_another_ir_from_the_canonical_zip`). El ZIP crudo del gateway sí es igual
  al directorio en los 82 según `BIM_EQUIVALENCE.md`; **no lo repetí aquí** (no es parte de estos tests).
* **CI de `bim-toolchain`** (`bim-toolchain/.github/workflows/ci.yml`): el job `golden-corpus` **falla** sin corpus salvo
  `BIM_CORPUS_OPTIONAL=true` (`:136-144`), y `gate` exige `success` en todos (`:239-256`); `tools/test_workflows.py:57-81`
  lo protege. Por tanto la frase del informe ("sale 0 con aviso") ya no describe el fichero.
* **Lo que sigue sin ser una garantía:**
  1. El propio fichero dice que no se ha ejecutado (`:1`) y está en un `.github/` anidado, que GitHub no ejecuta
     dentro de este monorepo; el CI efectivo es `.github/workflows/ci.yml` de la raíz.
  2. La variable `BIM_CORPUS_OPTIONAL=true` hace pasar el `gate` con solo un aviso (`:137-141`): es un interruptor, no
     una prueba.
  3. En `golden-corpus`, el segundo comando (`pytest …test_baseline_equivalence.py`, `:146`) contiene `pytest.skip` que
     no respetan `BIM_REQUIRE_CORPUS` (p. ej. por ausencia de los goldens originales de OpenBinding o de los de
     `bim_core`: líneas 83, 100, 343 del test) y el job no busca `SKIPPED`, a diferencia de `equivalence` y
     `contracts` (`:101-107`, `:170-176`): un skip ahí es verde.
  4. El CI raíz (`.github/workflows/ci.yml:13-57`, job `bim-corpus`) compila los 82 desde directorio con
     `check_bim_corpus.py --expected 82`: comprueba que compilan, **no** compara con los goldens ni con el ZIP. Ningún job
     raíz ejecuta `baseline_core.py --check` ni las suites de `bim-toolchain`.
  5. `BIM_BASELINE_FULL` (los 82 desde ZIP en el gateway) no se activa en ningún workflow (solo aparece en tests y
     docs); el CI raíz ejecuta la muestra.
* **No verificado por mí**: `baseline_core.py --check` contra los goldens en esta cabeza (no es un check registrado);
  el informe hermano anota 295 passed / 64 xfailed el 2026-10-13. Tampoco que "51 de 82 se evalúan con muestra de 16"
  (cifra de `SECURITY_REVIEW.md:34`).

### 4.2 (b) Lista por lista: ¿conjunto o secuencia con significado?

Origen común: JSON no da significado al orden de los miembros de un objeto, y la forma canónica los ordena
(`package.py:75-88`, `canonical.py:93-98`); el compilador construye estas listas iterando objetos (`BIM_EQUIVALENCE.md`
§1). El digest semántico las incluye tal cual (`compiler.py:3494-3510` excluye solo `metadata`, `instance`, `dialects`,
`sourceMap`).

| Lista del IR | Se construye en | Consumidores del orden | Veredicto | Cambia en (de 82) |
|---|---|---|---|---|
| `spec.eligibility[tarea]` | `compiler.py:2048-2149` (catálogos × candidatos, orden de objetos) | Python: pertenencia (`:3650`), longitud (`:3604`), `neighborhood` ya ordena (`neighborhood.py:89-94`) → **sin orden**. Motores con semilla: `V1RandomSearch.java:68-69`, `EvolutionarySolver.java:119-120`, `:167-169` toman `eligible.get(random.nextInt(n))`; MiniZinc indexa candidatos y dominios por posición (`dzn_builder.ts:60`, `:64-81`) | **Conjunto para la corrección; secuencia solo como espacio de índices de semilla/búsqueda** | 46 |
| `spec.constraints` | `compiler.py:2790-2843` | `evaluate_constraints` evalúa cada una de forma independiente y añade violaciones en el orden de la lista (`:4168-4191`); la suma de penalizaciones es de punto flotante en ese orden (`:4214`) | **Conjunto**; el orden se ve en el orden de `violations` y, en teoría, en el último bit de una suma | 59 |
| `spec.placement` (lista de modelos) | `compiler.py:2910-3126` | bucles `:4029`, `_placement_assignment` exige exactamente 1 (`:3727-3740`) | **Conjunto** (clave `resource`) | 7 |
| `placement[].demands` | `:2934-2993`, `:3119` | diccionario por candidato (`:4030-4032`) | **Conjunto** (mapa candidato → pool). Las `demands` del autor son un array y **sobrescriben** a los grupos (`:2993`, `override=True`): ese orden es dato del autor y no cambia | 2 |
| `placement[].transitions` | `:3054-3081` | `:4092-4108`, una violación por transición | **Conjunto**; orden visible en `violations` | 7 |
| `placement[].network` | `:2994-3032` | búsqueda por par (`:3749-3751`); pares duplicados prohibidos (`:3007`) | Array del autor, semánticamente conjunto; **no cambia** en los 82 | 0 |
| `placement[].capacityRules` | `:3100-3115` | su `ref` contiene el índice (`capacityRules/{i}`, `:3107`) | **El orden es identidad**: no ordenar | 0 |
| `spec.sourceMap` | claves con índice (`:2836`, `:2932`, `:3111`) | no semántico (`ir_digest` lo excluye) | derivado: se re-indexa tras ordenar | todas las anteriores |

`eligibility` merece precisión: ordenarla **no altera ninguna evaluación ni ninguna decisión**, pero cambia qué binding da
una semilla. Simulado con `Random(20261012)` sobre las 46 listas que cambian, **las 46 dan otro binding** entre
directorio y ZIP canónico y **0** tras ordenar (`test_a_seeded_draw_from_the_eligibility_lists_depends_on_their_order`).
No se ejecutaron los motores reales (el generador de Java difiere del de Python, el mapeo índice → candidato es el mismo).

### 4.3 Impacto cuantificado

Datos previos (`BIM_EQUIVALENCE.md` §2, no re-medidos salvo lo marcado): 64 paquetes cambian de digest semántico e
`irDigest`; `packageDigest` no cambia en ninguna forma; en las evaluaciones exhaustivas se mantiene el resumen y cambian
`rollupDigest` y los digests por binding en 63 de 64; en los 33 muestreados cambian también los resúmenes (otras
extracciones de la semilla).

Medido ahora, sobre **6 bindings idénticos por paquete** (elegidos desde la lista ordenada para que sean los mismos en
ambos lados; 492 evaluaciones):

| Comparación | Idénticas | Solo orden de `violations` | Solo texto de `message` | Orden + texto | Otra diferencia |
|---|---:|---:|---:|---:|---:|
| directorio frente a ZIP canónico | 313 | 164 | 9 | 6 | **0** |
| IR del directorio frente a ese IR con las listas ordenadas | 322 | 170 | – | – | **0** |

"Otra diferencia" incluye `features`, `objectives`, penalizaciones y `score`: **ninguna cambia por el orden**
(`test_evaluations_of_the_same_binding_differ_only_in_violation_order_and_message_text`,
`test_sorting_the_lists_never_changes_an_evaluation_beyond_violation_order`). Falta, y no se midió: motores reales con
semilla, y bindings que no sean las 6 de la muestra.

### 4.4 Hallazgo adicional: una segunda divergencia, de números, independiente del orden

Las 15 evaluaciones (9 + 6) con diferencia de `message` pertenecen a paquetes con `placement`; inspeccioné la primera
diferencia de cada uno de los 7 paquetes con `placement` y en todas el texto cambia de `maximum 6.0` a `maximum 6`
(o `14.0` a `14`): la forma canónica (JCS) escribe `6.0` como `6`, el cargador lo lee como entero y el mensaje usa el
valor tal cual (`compiler.py:4105-4107`). El digest semántico no se ve afectado (JCS imprime ambos igual), pero
**ordenar listas no iguala la evaluación completa** de esos paquetes: el texto seguirá distinto (y los digests de
evaluación del baseline tampoco, si incluyen el mensaje; no lo comprobé). Elegir un formato de números independiente
de la forma exige una convención, y cualquiera mueve el texto de una de las dos formas: va en la fase B. No comprobé
las 15 evaluaciones una por una, solo la primera de cada paquete.

### 4.5 Decisión

**(1) Arreglo compatible que iguale los IR sin tocar digests semánticos: no existe.** Las tres listas están dentro del
digest (`compiler.py:3494-3510`); igualar directorio y ZIP exige ordenar en el directorio (mueve esos 64:
`test_the_proposed_order_would_move_the_semantic_digest_of_exactly_these_packages`) o recuperar en el ZIP un orden que
la forma canónica ya destruyó (imposible). Lo compatible es **no igualar, pero hacer la equivalencia comprobable**:

* **Fase A (MINOR, aditiva, sin mover ningún golden).** Una función pura `ir_order_digest(document)` (digest del IR con
  las listas "de objeto" ordenadas, sin `sourceMap`; la referencia ejecutable es `normalized()` de
  `test_analysis_ir_probe.py`) y un campo aditivo en `/compile` y `/validate`. Se demuestra con el test existente
  `test_sorting_the_object_derived_lists_gives_one_ir_for_both_forms`: **82/82** formas coinciden. Sirve para (i) un test de
  CI que sustituya al xfail como prueba positiva de equivalencia, (ii) deduplicar snapshots sin depender de qué forma se
  subió primero (hoy la clave `(owner, package_digest, compilation_digest)` es igual para ambas formas,
  `snapshots.py:323-328`, y se queda con el IR del primero), (iii) detectar en el gateway que un paquete llegó en la otra
  forma.
* **Fase B (MAJOR, decisión del propietario).** Ordenar en el compilador (§4.6). Motivos para hacerlo: hoy dos subidas del
  mismo paquete pueden dar dos IR, y el binding que produce una semilla depende de quién subió primero. Motivos para no
  tener prisa: la exposición real es pequeña (la plataforma sube la forma cruda con `zip_files`,
  `integrations/packages.py:26-36`, y solo `tools/build_bim_packages.py` o clientes del SDK que usen `to_zip()`
  producen la otra) y la corrección de las evaluaciones no está afectada (0 diferencias numéricas).

Riesgo real: dos IR por paquete y dependencia de la semilla del orden de subida. Hipotético: resultados incorrectos por
el orden (no hay ninguno medido).

### 4.6 Contratos (M4 / IR)

**M4-A (fase A, MINOR).**
* Dueño: `bim-core/src/bim_core/compiler.py` (función nueva, sin tocar la compilación) y export en `__init__.py`;
  `bim-service/src/bim_service/operations.py` y `models.py` (campo aditivo `irOrderDigest`); `bim-client/types.py`;
  `contracts/openapi/bim-service.v1.json`; `docs/DIGESTS.md`.
* Tests: `normalized()` pasa a `bim-core/tests`; para los 82: `ir_order_digest` igual en directorio, ZIP crudo y ZIP
  canónico; `ir_digest` y los goldens **sin cambios** (`baseline_core.py --check` limpio); `dump_service_openapi.py
  --check` y `consumer_fixtures.py --check` regenerados solo en lo aditivo.
* Criterio: ningún golden de `golden/` modificado; versión MINOR; el xfail `test_a_directory_and_its_canonical_zip_compile_to_the_same_ir`
  sigue en `xfail` (no cambia el hecho).

**M4-B (fase B, MAJOR).**
* Regla: ordenar al final de `_compile_qos_binding` (después de `compiler.py:4271`, `:4364`, `:4367`): `eligibility` por
  `(resource, id)`; `constraints` por `ref`; `placement` por `resource`; `demands` por candidato; `transitions` por `ref`;
  no ordenar `network` ni `capacityRules`. El `sourceMap` se **genera después** de ordenar (hoy las claves se escriben al
  construir, `:2836`, `:2932`, `:3095`, `:3111`).
* Convención de números en mensajes (§4.4): decidirla y documentarla; es la única parte que puede mover el texto de la
  forma directorio.
* Conservar la ruta actual: opción `irOrder = "document" | "canonical"`, por defecto `document` en la versión que la
  introduce; la opción entra en `inputDigest` y en `compilationDigest` para que ambas rutas convivan como snapshots
  distintos; el defecto pasa a `canonical` en la siguiente MAJOR; `document` se retira después.
* Versión: MAJOR por `RELEASING.md:16` y `DIGESTS.md:189-193` (un paquete válido cambia de digest); `0.1.0` no se ha
  publicado, así que puede plegarse en la primera publicación (`BIM_EQUIVALENCE.md:126-130`).
* Vectores y goldens: el golden actual (`golden/bim_baseline`, `golden/bim_core`) sigue protegiendo la ruta `document`;
  la ruta `canonical` tiene golden propio nuevo (`golden/bim_canonical/`, creado con `check_or_create_golden`). Un
  test fija **exactamente** qué entradas se mueven: las 64 del corpus (más derivados de rollup), ninguna otra
  (existe un precedente en el gateway: `test_a_canonical_order_would_move_the_golden_of_exactly_the_divergent_packages`).
  Regeneración con `tools/baseline_core.py` en un cambio revisado que diga por qué (`RELEASING.md:16`).
* Migración local: los IR ya guardados siguen siendo válidos y evaluables sin recompilar (492/492 evaluaciones iguales
  salvo orden de violaciones); la deduplicación por `compilationDigest` los separa de los nuevos. Las ejecuciones de
  motores con semilla ya hechas guardan bindings por identidad, no por índice, y no se invalidan; las que se
  repitan con la misma semilla darán otro binding.
* Motores: revisar tests de motores que fijen salidas con semilla (`engines/**`); **no los inspeccioné**.
* Criterio de hecho: `test_a_directory_and_its_canonical_zip_compile_to_the_same_ir` pasa en modo `canonical` (se convierte
  en test normal para ese modo); los 82 ZIP crudo, canónico y directorio dan el mismo `irDigest`; las evaluaciones
  coinciden también en `message`.

**M4-CI.**
* Dueño: `.github/workflows/ci.yml` (raíz) y `bim-toolchain/.github/workflows/ci.yml`.
* Hecho cuando: un job raíz ejecuta `baseline_core.py --check` con `BIM_REQUIRE_CORPUS=1`, falla si el corpus no tiene
  exactamente 82, y busca `SKIPPED` en la salida (como `equivalence`); `BIM_CORPUS_OPTIONAL` no puede estar activo en la
  rama principal; el job aparece en `gate`. Mientras el CI de `bim-toolchain` no se haya ejecutado nunca, no debe
  describirse como protección.

## 5. Tests añadidos (`bim-toolchain/packages/bim-service/tests/analysis/`)

| Fichero | Pasan | xfail estricto |
|---|---:|---:|
| `test_analysis_b5_tenant_identity.py` | global independiente; quemar etiqueta ajena (comportamiento actual); la cabecera no cambia respuestas; SDK sin cabeceras del usuario | rotar etiqueta; omitir/malformar (2); rotación sin contador común |
| `test_analysis_b8_probe.py` | operaciones en el pool; healthz con operaciones bloqueadas; intervalo de GIL corto mantiene healthz | GIL con 4 operaciones CPU; decodificación fuera del bucle; validación fuera del bucle; parada por cuerpo grande; "sin slot no se decodifica"; timeout libera el slot |
| `test_analysis_b8_memory.py` | pico previo al slot acotado (3,8× y 7,9×) | – |
| `test_analysis_ir_probe.py` | 64/82; listas que cambian (46/59/7/2/7/0/0); mismos elementos; ordenar iguala ambas formas; ordenar movería exactamente 64; evaluaciones 313/164/9/6/0; ordenar no cambia evaluaciones (322/170); semilla 46/46 → 0 | directorio y ZIP canónico dan el mismo IR |

Total en la última ejecución: 16 passed, 11 xfailed. Los nombres de los ficheros `*_probe.py` son "sonda" en sentido de
medición; no hay ficheros temporales pendientes. Los tests de B8 que miden tiempo usan umbrales relativos o anchos
(mediana frente a 20-30 ms, parada frente al 30 % del parseo síncrono) para no depender de la velocidad de la máquina;
aun así los dos de latencia pueden dar un falso resultado en una máquina muy cargada.

## 6. No verificado

* Nada se midió con sockets, uvicorn, varios workers ni en el contenedor del laboratorio (`cpus`, `mem_limit`, cgroup).
* La memoria es de asignaciones Python (`tracemalloc`), no RSS; el valor a 32 MiB es extrapolación lineal.
* El coste de rendimiento de `setswitchinterval` salió de una sola ejecución ruidosa.
* RSS de un worker `bim_core` (condiciona el modo `process`), tiempo de reposición de un worker y comportamiento de
  SIGTERM con hilos vivos.
* No hay peor caso real de compilación o evaluación (ningún paquete patológico probado): la gravedad de "un hilo
  retiene su slot" depende de él.
* `baseline_core.py --check`, las 82 en ZIP crudo frente a directorio, Python 3.12 y los workflows en GitHub no se
  ejecutaron; tampoco `docker compose` ni el despliegue Kubernetes.
* Motores reales con semilla; tests de motores que fijen salidas con semilla.
* `normalized(canonical) == canonical` no se fijó como test: en una sonda previa se cumplía en 75 de 82 y fallaba en los
  7 con `placement` (el ZIP canónico conserva el orden de `network` del autor y el de grupos en `demands`), lo que
  desmiente la afirmación de `BIM_EQUIVALENCE.md` §3 de que "el IR del ZIP canónico es exactamente el IR normalizado":
  el orden por identificador que se propone aquí **no** coincide con el que hoy produce el ZIP canónico.
* La cifra "51 de 82 con muestra de 16" y el estado del CI de GitHub.

## Estado de la decisión

1. B5: abierto. Diseño por identidad (token → tenant) y contratos B5-S/C/G/D listos; cuidado con la regresión de
   capacidad si solo hay un tenant (§2.4, punto 5).
2. B8: parcialmente atendido. Primero admisión + trabajo completo en el pool + intervalo de GIL (reversibles, sin
   subir límites); procesos solo tras medir RSS (B8-0).
3. M4/IR: no existe arreglo compatible que iguale los IR. Fase A (clave de equivalencia aditiva) ahora; fase B MAJOR con
   la ruta actual conservada detrás de `irOrder`, a decidir por el propietario. No se tocó ningún golden ni se
   convirtió ningún xfail en skip.

## Estado de este documento

* Base: `cd0e05f0`.
* Tests de análisis: 16 passed + 11 xfailed estrictos. Los 11 xfail son defectos abiertos B5/B8/IR.
* No hay cambios de producción.
