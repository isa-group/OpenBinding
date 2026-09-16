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

### Command-line Arguments

| Argument | Description | Default |
| :--- | :--- | :--- |
| `-t`, `--tasks` | Number of abstract service activities | `10` |
| `-c`, `--candidates` | Number of candidate services per activity | `5` |
| `-cf`, `--control-flow` | Percentage of control flow activities (0-90) | `50` |
| `-l`, `--loops` | Relative percentage of loops | `30.0` |
| `-b`, `--branches` | Relative percentage of branches | `30.0` |
| `-p`, `--parallel` | Relative percentage of parallel flows | `20.0` |
| `-n`, `--nesting` | Maximum control structure nesting depth | `3` |
| `-i`, `--iterations` | Average iterations per loop structure | `5` |
| `-q`, `--qos` | Number of QoS dimensions (1-5) | `5` |
| `-k`, `--constraints` | Number of global constraints | `1` |
| `-o`, `--output` | Output filepath (stdout if omitted) | stdout |

### Building and Running

```bash
# Build the JAR
mvn -pl bim-generator package

# Run generation
java -jar target/bim-generator-0.1.0-SNAPSHOT.jar -t 20 -c 10 -o problem.txt
```
