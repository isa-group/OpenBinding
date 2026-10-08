"""Native Python synthesizer for QACO problem instances without JVM overhead."""

from __future__ import annotations

import random
import json
import subprocess
import tempfile
from pathlib import Path

from ..v1.package import InstancePackage
from .compatibility import IncompatibleTargetEnginesError, TargetCapabilities, _load_engine_manifest, resolve_engine_capabilities
from .legacy_parser import (
    CandidateService,
    LegacyConstraint,
    LegacyProblem,
    QoSPropertySpec,
    StructureNode,
    parse_legacy_file,
)
from .postprocessor import BIMPostprocessor


def sample_distribution(spec: dict, rng: random.Random, *, integer: bool = False) -> float | int:
    if spec["kind"] == "normal":
        value = rng.gauss(spec["mean"], spec["stddev"])
    elif integer:
        return rng.randint(int(spec["minimum"]), int(spec["maximum"]))
    else:
        value = rng.uniform(spec["minimum"], spec["maximum"])
    if integer:
        value = int(round(value))
    bounded = max(spec["minimum"], min(spec["maximum"], value))
    return int(bounded) if integer else bounded


class ProblemSynthesizer:
    """Native Python generator synthesizing QACO instances with controllable topology and distributions."""

    def __init__(
        self,
        tasks: int = 10,
        candidates: int = 5,
        control_flow: int = 50,
        loops: float = 30.0,
        branches: float = 30.0,
        parallel: float = 20.0,
        max_nesting: int = 3,
        iterations_per_loop: int = 5,
        qos_properties: int = 5,
        features: list[dict] | None = None,
        distributions: dict | None = None,
        constraints: int = 1,
        constraint_count_mode: str = "exact",
        seed: int | None = None,
        target_capabilities: TargetCapabilities | None = None,
    ):
        self.tasks = max(2, tasks)
        self.candidates = max(2, candidates)
        self.control_flow = max(0, min(90, control_flow))
        self.loops_pct = max(0.0, loops)
        self.branches_pct = max(0.0, branches)
        self.parallel_pct = max(0.0, parallel)
        self.max_nesting = max(1, max_nesting)
        self.iterations_per_loop = max(1, iterations_per_loop)
        self.qos_count = max(1, min(5, qos_properties))
        self.features = features
        self.distributions = distributions or {}
        self.constraint_count_mode = constraint_count_mode
        self.constraints_count = max(0, constraints)
        self.seed = seed
        self.capabilities = target_capabilities or TargetCapabilities(target_engines=[])

        self.rng = random.Random(seed)

    def _generate_structure(self, abstract_services: list[str]) -> StructureNode:
        """Build a control structure tree ensuring no empty branches or dead nodes."""
        n_cf = int(round(self.tasks * self.control_flow / 100.0))
        n_cf = max(0, min(n_cf, self.tasks - len(abstract_services)))

        # Create control components to insert
        total_cf_pct = self.loops_pct + self.branches_pct + self.parallel_pct
        if total_cf_pct <= 0:
            p_loop, p_branch = 0.33, 0.33
        else:
            p_loop = self.loops_pct / total_cf_pct
            p_branch = self.branches_pct / total_cf_pct

        cf_nodes: list[StructureNode] = []
        for _ in range(n_cf):
            r = self.rng.random()
            if r < p_loop:
                iters = (sample_distribution(self.distributions["loop_iterations"], self.rng, integer=True)
                         if "loop_iterations" in self.distributions else
                         max(1, self.rng.randint(self.iterations_per_loop - 1, self.iterations_per_loop + 2)))
                cf_nodes.append(StructureNode(kind="loop", iterations=iters, children=[]))
            elif r < p_loop + p_branch:
                # 2 or 3 branches
                n_b = (sample_distribution(self.distributions["branches_per_decision"], self.rng, integer=True)
                       if "branches_per_decision" in self.distributions else
                       (2 if self.rng.random() < 0.8 else 3))
                raw_probs = [self.rng.uniform(0.2, 0.8) for _ in range(n_b)]
                cf_nodes.append(StructureNode(kind="branch", probabilities=raw_probs, children=[StructureNode(kind="sequence") for _ in range(n_b)]))
            else:
                n_p = 2
                cf_nodes.append(StructureNode(kind="flow", children=[StructureNode(kind="sequence") for _ in range(n_p)]))

        # Root sequence
        root = StructureNode(kind="sequence", children=[])
        nesting_levels: dict[int, int] = {id(root): 0}
        insertion_targets: list[StructureNode] = [root]

        for cf in cf_nodes:
            # Pick a target that does not exceed max nesting
            valid_targets = [t for t in insertion_targets if nesting_levels.get(id(t), 0) < self.max_nesting]
            target = self.rng.choice(valid_targets) if valid_targets else root
            cur_level = nesting_levels.get(id(target), 0)

            target.children.append(cf)
            nesting_levels[id(cf)] = cur_level + 1

            if cf.kind in ("loop", "flow"):
                insertion_targets.append(cf)
            elif cf.kind == "branch":
                for b_seq in cf.children:
                    nesting_levels[id(b_seq)] = cur_level + 2
                    insertion_targets.append(b_seq)

        # Distribute abstract services
        # 1. Ensure every branch and loop has at least one service
        unassigned = list(abstract_services)
        for cf in cf_nodes:
            if cf.kind == "branch":
                for b_seq in cf.children:
                    svc = unassigned.pop(0) if unassigned else self.rng.choice(abstract_services)
                    b_seq.children.append(StructureNode(kind="task", id=svc))
            elif cf.kind == "flow":
                for p_seq in cf.children:
                    svc = unassigned.pop(0) if unassigned else self.rng.choice(abstract_services)
                    p_seq.children.append(StructureNode(kind="task", id=svc))
            elif cf.kind == "loop":
                if not cf.children:
                    svc = unassigned.pop(0) if unassigned else self.rng.choice(abstract_services)
                    cf.children.append(StructureNode(kind="task", id=svc))

        # 2. Distribute remaining services across insertion targets
        while unassigned:
            svc = unassigned.pop(0)
            target = self.rng.choice(insertion_targets)
            target.children.append(StructureNode(kind="task", id=svc))

        # If root ended up empty, put all services in root
        if not root.children:
            root.children = [StructureNode(kind="task", id=s) for s in abstract_services]

        return root

    def synthesize(self) -> LegacyProblem:
        """Synthesize a complete LegacyProblem representation."""
        # 1. Abstract Services
        n_abstract = max(2, (self.tasks * (100 - self.control_flow)) // 100)
        abstract_services = [f"t{i + 1}" for i in range(n_abstract)]

        # 2. Control Structure
        structure = self._generate_structure(abstract_services)

        # 3. QoS Properties
        all_props = [
            QoSPropertySpec(name="Cost", direction="minimize", domain_min=0.0, domain_max=100.0, weight=0.3),
            QoSPropertySpec(name="ExecTime", direction="minimize", domain_min=0.0, domain_max=500.0, weight=0.3),
            QoSPropertySpec(name="Reliability", direction="maximize", domain_min=0.0, domain_max=1.0, weight=0.15),
            QoSPropertySpec(name="Availability", direction="maximize", domain_min=0.0, domain_max=1.0, weight=0.15),
            QoSPropertySpec(name="Security", direction="maximize", domain_min=0.0, domain_max=1.0, weight=0.1),
        ]
        # If target capabilities demand min_objectives, ensure at least that many
        req_objs = max(self.qos_count, self.capabilities.min_objectives)
        qos_props = ({item["id"]: QoSPropertySpec(name=item["id"], direction=item["direction"],
                        domain_min=item["distribution"]["minimum"], domain_max=item["distribution"]["maximum"])
                     for item in self.features} if self.features is not None else
                     {p.name: p for p in all_props[:min(req_objs, len(all_props))]})
        value_distributions = {item["id"]: item["distribution"] for item in self.features or []}

        # 4. Candidates per task
        candidates: dict[str, list[CandidateService]] = {}
        for task in abstract_services:
            c_list: list[CandidateService] = []
            count = (sample_distribution(self.distributions["candidate_count"], self.rng, integer=True)
                     if "candidate_count" in self.distributions else self.candidates)
            for c_idx in range(count):
                c_name = f"s_{task}_{c_idx + 1}"
                features = {}
                for p_name, prop in qos_props.items():
                    # Generate values within domain
                    val = (sample_distribution(value_distributions[p_name], self.rng)
                           if self.features is not None else self.rng.uniform(prop.domain_min, prop.domain_max))
                    features[p_name] = val if self.features is not None else round(val, 4)
                c_list.append(CandidateService(name=c_name, features=features))
            candidates[task] = c_list

        # 5. Initial constraints
        constraints: list[LegacyConstraint] = []
        prop_list = list(qos_props.values())
        if self.features is None:
            selected = [prop_list[index % len(prop_list)] for index in range(self.constraints_count)]
        elif self.constraint_count_mode == "exact":
            selected = self.rng.sample(prop_list, self.constraints_count)
        else:
            selected = [p for p in prop_list if self.rng.random() < self.constraints_count / len(prop_list)]
        for p in selected:
            op = "<=" if p.direction == "minimize" else ">="
            mid = (sample_distribution(self.distributions["constraint_optimality_percent"], self.rng)
                   if "constraint_optimality_percent" in self.distributions else
                   (50.0 if self.features is not None else 0.5 * (p.domain_min + p.domain_max)))
            constraints.append(LegacyConstraint(property_name=p.name, operator=op, value=mid))

        metadata = {
            "activities": self.tasks,
            "candidates": sum(map(len, candidates.values())),
            "constraints": len(constraints),
            "seed": self.seed,
        }

        return LegacyProblem(
            abstract_services=abstract_services,
            structure=structure,
            qos_properties=qos_props,
            candidates=candidates,
            constraints=constraints,
            metadata=metadata,
        )


def run_legacy_cli(
    tasks: int = 10,
    candidates: int = 5,
    control_flow: int = 50,
    loops: float = 30.0,
    max_nesting: int = 3,
    iterations_per_loop: int = 10,
    constraints: int = 1,
    optimality: float = 65.0,
    seed: int | None = None,
    config: dict | None = None,
) -> str:
    """Invoke the Java BimGeneratorCli and return its stdout text."""
    # Find the jar in engines/bim-generator/target
    current_dir = Path(__file__).resolve()
    # openbinding-gateway/src/openbinding_gateway/generator/synthesizer.py -> root is parents[4]
    repo_root = current_dir.parents[4]
    jar_path = repo_root / "engines" / "bim-generator" / "target" / "bim-generator-0.1.0-SNAPSHOT.jar"

    if not jar_path.is_file():
        raise FileNotFoundError(f"Legacy BIM generator jar not found at {jar_path}. Run mvn package in engines.")

    if config is not None:
        lines = [f"{key}={value}" for key, value in sorted(config.items())]
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "generator.properties"
            config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            res = subprocess.run(["java", "-jar", str(jar_path), "--config", str(config_path)],
                                 capture_output=True, text=True, check=True)
            return res.stdout

    cmd = [
        "java", "-jar", str(jar_path),
        "--tasks", str(tasks),
        "--candidates", str(candidates),
        "--control-flow", str(control_flow),
        "--loops", str(loops),
        "--max-nesting", str(max_nesting),
        "--iterations", str(iterations_per_loop),
        "--constraints", str(constraints),
        "--optimality", str(optimality),
    ]
    if seed is not None:
        cmd.extend(["--seed", str(seed)])

    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return res.stdout


def _java_config(*, tasks: int, candidates: int, control_flow: int, loops: float, branches: float,
                 parallel: float, max_nesting: int, iterations_per_loop: int, constraints: int,
                 constraint_count_mode: str, features: list[dict], distributions: dict,
                 seed: int | None) -> dict[str, str]:
    config = {"tasks": str(tasks), "candidates": str(candidates), "control_flow": str(control_flow),
              "loops": str(loops), "branches": str(branches), "parallel": str(parallel),
              "max_nesting": str(max_nesting), "iterations_per_loop": str(iterations_per_loop),
              "constraints": str(constraints), "constraint_count_mode": constraint_count_mode,
              "seed": str(seed if seed is not None else random.SystemRandom().randrange(2**63)),
              "feature.count": str(len(features))}
    for index, feature in enumerate(features):
        config[f"feature.{index}.id"] = feature["id"]
        for key, value in feature["distribution"].items():
            if value is not None:
                config[f"feature.{index}.distribution.{key}"] = str(value)
    for name, distribution in distributions.items():
        for key, value in distribution.items():
            if value is not None:
                config[f"distribution.{name}.{key}"] = str(value)
    return config


def _configured_java_problem(raw: str, features: list[dict]) -> LegacyProblem:
    data = json.loads(raw)

    def node(value: dict) -> StructureNode:
        return StructureNode(kind=value["kind"], id=value.get("id"), iterations=value.get("iterations", 1),
                             probabilities=value.get("probabilities", []),
                             children=[node(child) for child in value.get("children", [])])

    qos = {feature["id"]: QoSPropertySpec(name=feature["id"], direction=feature["direction"],
           domain_min=feature["distribution"]["minimum"], domain_max=feature["distribution"]["maximum"])
           for feature in features}
    constraints = [LegacyConstraint(property_name=item["id"], operator=("<=" if qos[item["id"]].direction == "minimize" else ">="),
                                    value=item["percent"]) for item in data["constraints"]]
    return LegacyProblem(abstract_services=data["tasks"], structure=node(data["structure"]), qos_properties=qos,
                         candidates={task: [CandidateService(name=item["name"], features=item["features"])
                                           for item in services] for task, services in data["candidates"].items()},
                         constraints=constraints)


def _validate_target_modes(target_engines: list[str], optimization: str, features: list[dict],
                           tasks: int, candidates: int, control_flow: int, loops: float,
                           branches: float, parallel: float, distributions: dict) -> None:
    abstract = max(2, tasks * (100 - control_flow) // 100)
    controls = min(round(tasks * control_flow / 100), tasks - abstract)
    nodes = {"task", "sequence"}
    if controls:
        if loops:
            nodes.add("repeat.count")
        if branches:
            nodes.add("exclusive.probabilistic")
        if parallel:
            nodes.add("parallel")
    scopes = {item["scope"] for item in features}
    aggregations = {f"{block}.{operator}" for item in features
                    for block, operator in item["aggregation"].items() if operator is not None}
    max_candidates = distributions.get("candidate_count", {}).get("maximum", candidates)

    def supports(descriptor: dict, required: set[str]) -> bool:
        return descriptor.get("selector") == "all" or required.issubset(set(descriptor.get("values", [])))

    for engine in target_engines:
        manifest = _load_engine_manifest(engine)
        modes = manifest["spec"]["modes"]
        compatible = []
        for mode in modes:
            caps = mode.get("capabilities", {})
            scalarizations = {item.get("id") for item in caps.get("scalarizations", {}).get("values", [])}
            limits = mode.get("limits", {})
            if (optimization in scalarizations and
                    supports(caps.get("workflowNodes", {}), nodes) and
                    supports(caps.get("featureScopes", {}), scopes) and
                    supports(caps.get("aggregations", {}), aggregations) and
                    abstract <= limits.get("maxTasks", float("inf")) and
                    abstract * max_candidates <= limits.get("maxCandidates", float("inf")) and
                    sum(item["objective"] for item in features) >= limits.get("minObjectives", 1)):
                compatible.append(mode["id"])
        if not compatible:
            raise IncompatibleTargetEnginesError(
                f"target_engines.{engine}: no mode supports this workflow, feature scopes, aggregations and size with {optimization}; adjust the configuration or remove this target engine",
                conflicts=[{"engine": engine, "dimension": "generation_mode", "workflowNodes": sorted(nodes),
                            "featureScopes": sorted(scopes), "aggregations": sorted(aggregations),
                            "abstractTasks": abstract, "maxCandidates": abstract * max_candidates}],
            )


def generate_instance_package(
    tasks: int = 10,
    candidates: int = 5,
    control_flow: int = 50,
    loops: float = 30.0,
    branches: float = 30.0,
    parallel: float = 20.0,
    max_nesting: int = 3,
    iterations_per_loop: int = 5,
    qos_properties: int = 5,
    features: list[dict] | None = None,
    distributions: dict | None = None,
    constraints: int = 1,
    constraint_count_mode: str = "exact",
    target_engines: list[str] | None = None,
    optimization_mode: str | None = None,
    guarantee_feasibility: bool = True,
    tension: float = 0.7,
    name: str = "generated_instance",
    profile: str = "qos-binding/v1",
    dialects: list[str] | None = None,
    seed: int | None = None,
    use_legacy_engine: bool = False,
    validate_compile: bool = True,
) -> InstancePackage:
    """Unified generator entrypoint producing a valid BIM v1 InstancePackage."""
    caps = resolve_engine_capabilities(target_engines)
    distributions = distributions or {}
    if features is not None:
        objective_count = sum(item["objective"] for item in features)
        if objective_count < caps.min_objectives:
            raise IncompatibleTargetEnginesError(
                f"features: {objective_count} objective features cannot satisfy target engines requiring {caps.min_objectives}; add objective=true features",
                conflicts=[{"dimension": "minObjectives", "requested": objective_count, "required": caps.min_objectives}],
            )
        if target_engines:
            for item in features:
                for block, operator in item["aggregation"].items():
                    if operator is not None and f"{block}.{operator}" not in caps.allowed_aggregations:
                        raise IncompatibleTargetEnginesError(
                            f"features.{item['id']}.aggregation.{block}: {operator} unsupported by target_engines; choose a supported operator",
                            conflicts=[{"dimension": "aggregations", "feature": item["id"], "requested": f"{block}.{operator}"}],
                        )
    if optimization_mode:
        # Keep the old UI/API spelling as a compatibility shim. The canonical
        # execution identifiers are the manifest values used by OpenBinding.
        optimization_mode = {
            "weighted": "weighted-sum",
            "pareto": "pareto-front",
        }.get(optimization_mode, optimization_mode)
        if optimization_mode not in caps.allowed_optimizations:
            raise IncompatibleTargetEnginesError(
                f"Requested optimization mode {optimization_mode!r} not supported by target engines {target_engines}: allowed {caps.allowed_optimizations}",
                conflicts=[{"dimension": "scalarizations", "requested": optimization_mode, "allowed": caps.allowed_optimizations}],
            )
        if optimization_mode == "pareto-front" and features is not None and sum(item["objective"] for item in features) < 2:
            raise IncompatibleTargetEnginesError(
                "features: pareto optimization requires at least two objective=true features; add an objective",
                conflicts=[{"dimension": "minObjectives", "requested": 1, "required": 2}],
            )
        caps.default_optimization = optimization_mode
        caps.default_objective_type = "MANY" if optimization_mode == "pareto-front" else "SINGLE"

    if features is not None and target_engines:
        _validate_target_modes(target_engines, caps.default_optimization, features, tasks, candidates,
                               control_flow, loops, branches, parallel, distributions)

    if use_legacy_engine and features is not None:
        raw_text = run_legacy_cli(config=_java_config(tasks=tasks, candidates=candidates, control_flow=control_flow,
            loops=loops, branches=branches, parallel=parallel, max_nesting=max_nesting,
            iterations_per_loop=iterations_per_loop, constraints=constraints, constraint_count_mode=constraint_count_mode,
            features=features, distributions=distributions, seed=seed))
        problem = _configured_java_problem(raw_text, features)
    elif use_legacy_engine:
        raw_text = run_legacy_cli(
            tasks=tasks,
            candidates=candidates,
            control_flow=control_flow,
            loops=loops,
            max_nesting=max_nesting,
            iterations_per_loop=iterations_per_loop,
            constraints=constraints,
            seed=seed,
        )
        problem = parse_legacy_file(raw_text)
    else:
        synthesizer = ProblemSynthesizer(
            tasks=tasks,
            candidates=candidates,
            control_flow=control_flow,
            loops=loops,
            branches=branches,
            parallel=parallel,
            max_nesting=max_nesting,
            iterations_per_loop=iterations_per_loop,
            qos_properties=qos_properties,
            features=features,
            distributions=distributions,
            constraints=constraints,
            constraint_count_mode=constraint_count_mode,
            seed=seed,
            target_capabilities=caps,
        )
        problem = synthesizer.synthesize()

    postprocessor = BIMPostprocessor(
        name=name,
        profile=profile,
        dialects=dialects or ["qos-binding/v1"],
        capabilities=caps,
        guarantee_feasibility=guarantee_feasibility,
        tension=tension,
        repair_empty_branches=True,
        validate_compile=validate_compile,
        feature_definitions=features,
    )

    return postprocessor.process(problem)
