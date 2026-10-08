# BIM QACO Problem Generator (`bim-generator`)

The `bim-generator` module encapsulates the legacy Quality-Aware Service Composition (QACO) problem generation logic, augmented with a modern command-line interface and integrated into the OpenBinding ecosystem.

## Overview

The generator synthesizes benchmark problem instances containing:
- Abstract workflow structure (`SEC`, `BRANCH`, `LOOP`, `FLOW`)
- Multiple QoS properties with configurable aggregation functions and polarities
- Multiple candidate concrete services per abstract activity with multi-dimensional QoS distributions
- Global QoS constraints

The instances produced by `bim-generator` are parsed and lowered into strict, schema-compliant **BIM v1** packages (`instance.json`, `application.json`, `candidates.json`, `constraints.json`, `optimization.json`, and `routing.json`) by the OpenBinding gateway generator pipeline.

## CLI Usage

The module packages an executable JAR with two CLI entrypoints:
- `es.us.isa.qosawarewsbinding.cli.BimGeneratorCli` (primary)
- `es.us.isa.qosawarewsbinding.cli.QacoGeneratorCli` (alias)

### Configuración usada por la API

La API invoca `java -jar target/bim-generator-0.1.0-SNAPSHOT.jar --config /ruta/generator.properties`. El archivo se lee como Java Properties en UTF-8; la API lo valida y crea. Incluye la semilla, las features expandidas, sus distribuciones, los cuatro bloques de distribuciones, los porcentajes estructurales y el modo de conteo de restricciones. La salida de `--config` es JSON con estructura, candidatos y porcentajes de restricciones; el gateway construye los documentos BIM y evalúa los umbrales con el compilador común. `--config` no recibe ni emite pesos.

Las claves estructurales son `tasks`, `candidates`, `control_flow`, `loops`, `branches`, `parallel`, `max_nesting`, `iterations_per_loop`, `constraints`, `constraint_count_mode` y `seed`. `feature.count` indica cuántas features expandidas hay; cada una lleva `feature.N.id` y `feature.N.distribution.kind`, `.minimum`, `.maximum` y, si es normal, `.mean` y `.stddev`. Las distribuciones estructurales usan `distribution.candidate_count.*`, `distribution.loop_iterations.*`, `distribution.branches_per_decision.*` y `distribution.constraint_optimality_percent.*`. El gateway aporta aparte la unidad, el ámbito, la dirección, el objetivo y las agregaciones declaradas en la solicitud.

Las opciones CLI antiguas permanecen para generar el formato QACO histórico. No son el contrato del endpoint BIM.

### Command-line Arguments históricos

| Argument | Description | Default |
| :--- | :--- | :--- |
| `-t`, `--tasks` | Number of abstract service activities | `10` |
| `-c`, `--candidates` | Number of candidate services per activity | `5` |
| `-cf`, `--control-flow` | Percentage of control flow activities (0-90) | `50` |
| `-l`, `--loops` | Relative percentage of loops | `30.0` |
| `--max-nesting` | Maximum control structure nesting depth | `3` |
| `--iterations` | Average iterations per loop structure | `10` |
| `--constraints` | Expected number of global constraints | `1` |
| `--optimality` | Mean optimality percentage | `65` |
| `--seed` | Rejected in the historical mode; use `--config` for seeded generation | — |
| `-o`, `--output` | Output filepath (stdout if omitted) | stdout |

### Building and Running

```bash
# Build the JAR
mvn -pl bim-generator package

# Run generation
java -jar target/bim-generator-0.1.0-SNAPSHOT.jar -t 20 -c 10 -o problem.txt
```
