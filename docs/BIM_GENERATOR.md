# Generador BIM v1

`POST /v1/generator/instances` genera un paquete BIM con seis recursos. `POST /v1/generator/corpus` recibe la misma configuración en `base_config` y añade una semilla consecutiva a cada entrada. QFBS utiliza exclusivamente el endpoint HTTP de instancias, con una petición por instancia y la salida predeterminada.

## Contrato

`features` es obligatorio y no puede estar vacío. Cada definición incluye `unit`, `direction` (`minimize` o `maximize`), `scope`, `distribution` y `aggregation`. No se admiten `qos_properties`, plantillas ni pesos en la entrada de generación. Un `id` omitido se asigna como `qos_1`, `qos_2`, etc. `count` expande una definición en dimensiones independientes; con `id: "quality"` y `count: 2` los IDs son `quality_1` y `quality_2`. Los IDs explícitos se conservan literalmente: `ExecTime` y `latency` son diferentes.

- `scope: "selectedCandidate"` requiere únicamente `aggregation.selection` (`sum`, `product`, `min` o `max`). Agrega los candidatos seleccionados una vez por candidato distinto.
- `scope: "invocation"` requiere exactamente `sequence`, `parallel`, `exclusive` y `repeat`. `sequence` y `parallel` admiten `sum`, `product`, `min`, `max`; `exclusive` admite `weightedSum`, `weightedProduct`, `min`, `max`; `repeat` admite `scale`, `power`, `identity`. La evaluación sigue el árbol del workflow.
- `objective` vale `true` por defecto. Con `false`, la feature sigue disponible para candidatos y restricciones, pero no aparece en `optimization.json`. Las features objetivas aparecen todas como criterios sin pesos.
- `distribution` admite `uniform` o `normal`. Ambas declaran `minimum` y `maximum`; `normal` añade `mean` y `stddev > 0`. Los valores normales se acotan a los límites. Una distribución uniforme de cantidades enteras toma enteros inclusivos; una normal se redondea y se acota.

Ejemplo mínimo:

```json
{
  "tasks": 8,
  "features": [
    {"unit": "EUR", "direction": "minimize", "scope": "selectedCandidate",
     "distribution": {"kind": "uniform", "minimum": 1, "maximum": 100},
     "aggregation": {"selection": "sum"}},
    {"id": "ExecTime", "unit": "ms", "direction": "minimize", "scope": "invocation",
     "distribution": {"kind": "normal", "minimum": 1, "maximum": 500, "mean": 100, "stddev": 25},
     "aggregation": {"sequence": "sum", "parallel": "max", "exclusive": "weightedSum", "repeat": "scale"}}
  ],
  "constraints": 1,
  "seed": 42
}
```

`distributions.candidate_count`, `loop_iterations`, `branches_per_decision` y `constraint_optimality_percent` usan el mismo formato. Se muestrean por tarea, bucle, decisión y restricción, respectivamente. Si se omiten las dos primeras se usan los escalares `candidates` e `iterations_per_loop`; enviar a la vez el escalar y su distribución da 422 porque el escalar no tendría efecto. Las ramas por decisión se limitan a 2–10.

`constraint_count_mode: "exact"` (predeterminado) escoge `constraints` features distintas. Con `"expected"`, cada feature se escoge independientemente con probabilidad `constraints / número_de_features`; el número real puede variar de 0 al total y se devuelve en `actual_constraint_count` para la instancia y para cada entrada del corpus. En ambos modos, `constraints` no puede exceder el número de features expandidas.

Si se declara `constraint_optimality_percent`, cada umbral se calcula como `mínimo_aggregate + porcentaje/100 × (máximo_aggregate − mínimo_aggregate)`. Los extremos se obtienen evaluando las selecciones extremas con el compilador BIM, por lo que respetan `scope`, workflow, agregaciones y probabilidades. Requiere `guarantee_feasibility: false`; ese valor permite una instancia insatisfacible, pero no la fuerza. Sin la distribución, el porcentaje usado con garantía desactivada es 50. Con garantía activa, `tension` en `[0,1]` determina límites que admiten una misma selección testigo para todas las restricciones. Enviar `tension` expresamente cuando la garantía está desactivada da 422.

`target_engines` y `optimization_mode` son pistas opcionales de compatibilidad para validar capacidades antes de generar. El motor efectivo, sus opciones y cualquier peso se proporcionan al crear el job, no al generar la instancia; la plataforma no elige motor por el usuario.

## Salida JSON o BPMN y exportación

`dialects: ["qos-binding/v1"]` (predeterminado) devuelve el workflow JSON. Con
`dialects: ["bpmn-workflow/v1"]`, el propio endpoint devuelve `workflow.bpmn`
y la referencia correspondiente en `application.json`. El BPMN generado
incluye subprocesos estructurados anidados, XOR/AND y repeticiones
secuenciales estáticas.

Two requests whose parameters and seed are otherwise identical produce packages
that differ byte-wise but share the same `ir_digest` and the same evaluation of
every binding; that equivalence is guaranteed for the generator's paired
outputs. The pair does **not** share `compilation_digest`, because those are
different bytes compiled under different dialects, and that is what the
compilation digest covers.

The response carries both digests, since the two claims are wanted for
different purposes. `ir_digest` covers the lowered problem with `metadata`,
`spec.instance`, `spec.dialects` and `spec.sourceMap` stripped, so it is the
equivalence claim — the same lowered problem, whichever dialect the workflow was
written in — and it is the key to cache a problem under. `compilation_digest`
covers the portable package digest together with the profile, the dialects and
the compiler bundle digest, so it is the reproducibility claim — this toolchain,
compiling these bytes, produces this result — and it moves when the toolchain
moves. It is the value the platform stores on a snapshot, where it forms the
snapshot's identity together with `package_digest`, and publishes as
`compilationDigest` in provenance.

Until this was corrected, the `compilation_digest` field of the three generator
endpoints carried the IR digest. The field kept its name and gained its real
value, so a caller reading it for reproducibility now gets what the name says;
a caller who relied on the pairing equality has to read `ir_digest` instead.

Para guardar los bytes exactos recibidos por HTTP, envíe
`include_file_bytes: true` y decodifique cada entrada de
`file_bytes_base64`. Los objetos `files` siguen disponibles para inspección;
serializarlos de nuevo no es una forma fiable de reconstruir los bytes del
paquete. El script de QFBS en `experimentation/qacobench/generate_qfbs.py`
registra la configuración, semilla y digests devueltos por HTTP para repetir la generación.

## Permisos

| Endpoint | Quién puede llamarlo |
| --- | --- |
| `POST /v1/generator/instances`, `/corpus`, `/convert-legacy` | Cualquiera, incluso sin cuenta: son funciones puras de la petición y no tocan estado compartido. Con `persist: true` hace falta cuenta (401), y adjuntar el resultado a un proyecto (`project_id`) exige rol MEMBER o superior en él. |

Los tres endpoints son funciones puras de la petición (salvo `persist: true`). La calibración de un modelo compartido y el enrutado automático de motores se retiraron: ya no existe `calibrate-engine` en `routes/generator.py` (solo `/instances`, `/corpus` y `/convert-legacy`) y no hay sustituto.

## Límites y errores

Los errores de configuración devuelven HTTP 422 con el campo y la corrección: definiciones incompletas, claves desconocidas (incluidos `qos_properties`, `templates` y `weights`), IDs inválidos o duplicados tras expandir, agregaciones ajenas al `scope`, distribución mal acotada o no finita, ausencia de objetivos, incompatibilidad con motores, parámetros que quedarían sin efecto y exceso de dimensiones. Se admiten hasta 100 features expandidas y 1 000 000 de valores candidato-feature por instancia. Los límites existentes de tareas, candidatos, iteraciones y anidamiento continúan aplicándose.

Las solicitudes de QFBS solo contienen parámetros del contrato BIM descrito aquí. La cobertura estructural real se comprueba sobre cada paquete devuelto, no se deduce de los porcentajes solicitados.
