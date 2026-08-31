# Evolutionary heuristics engine

Categorical genetic search over canonical BIM v1 bindings. Crossover exchanges
complete `{resource,id}` genes and mutation samples from each task's compiled
eligibility domain. The modes are `elitist-genetic` and `pareto-genetic`; the
latter maintains a bounded non-dominated archive and requires Pareto
optimization.

The service accepts only `bim-engine/v1` `BindingProblem` requests at
`POST /internal/v1/binding-problems`. All feasibility, metric aggregation,
penalties and objective ranking use `binding-core`. Both modes declare
placement selector `all`, select only `qos-binding-placement/v1` in
`irExtensions`, and apply the complete lowered placement contract to every
chromosome. The engine never claims exactness, optimality or infeasibility.

Run `mvn test` with Java 17 or newer.
