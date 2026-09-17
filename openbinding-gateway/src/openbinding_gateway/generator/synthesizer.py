"""Native Python synthesizer for QACO problem instances without JVM overhead."""

from __future__ import annotations

import random
import subprocess
from pathlib import Path

from ..v1.package import InstancePackage
from .compatibility import TargetCapabilities, resolve_engine_capabilities
from .legacy_parser import (
    CandidateService,
    LegacyConstraint,
    LegacyProblem,
    QoSPropertySpec,
    StructureNode,
    parse_legacy_file,
)
from .postprocessor import BIMPostprocessor


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
        constraints: int = 1,
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
            p_loop, p_branch, p_par = 0.33, 0.33, 0.34
        else:
            p_loop = self.loops_pct / total_cf_pct
            p_branch = self.branches_pct / total_cf_pct
            p_par = self.parallel_pct / total_cf_pct

        cf_nodes: list[StructureNode] = []
        for _ in range(n_cf):
            r = self.rng.random()
            if r < p_loop:
                iters = max(1, self.rng.randint(self.iterations_per_loop - 1, self.iterations_per_loop + 2))
                cf_nodes.append(StructureNode(kind="loop", iterations=iters, children=[]))
            elif r < p_loop + p_branch:
                # 2 or 3 branches
                n_b = 2 if self.rng.random() < 0.8 else 3
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
        qos_props = {p.name: p for p in all_props[:min(req_objs, len(all_props))]}

        # 4. Candidates per task
        candidates: dict[str, list[CandidateService]] = {}
        for task in abstract_services:
            c_list: list[CandidateService] = []
            for c_idx in range(self.candidates):
                c_name = f"s_{task}_{c_idx + 1}"
                features = {}
                for p_name, prop in qos_props.items():
                    # Generate values within domain
                    val = self.rng.uniform(prop.domain_min, prop.domain_max)
                    features[p_name] = round(val, 4)
                c_list.append(CandidateService(name=c_name, features=features))
            candidates[task] = c_list

        # 5. Initial constraints
        constraints: list[LegacyConstraint] = []
        prop_list = list(qos_props.values())
        for c_idx in range(self.constraints_count):
            p = prop_list[c_idx % len(prop_list)]
            op = "<=" if p.direction == "minimize" else ">="
            mid = 0.5 * (p.domain_min + p.domain_max)
            constraints.append(LegacyConstraint(property_name=p.name, operator=op, value=mid))

        metadata = {
            "activities": self.tasks,
            "candidates": self.tasks * self.candidates,
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
) -> str:
    """Invoke the Java BimGeneratorCli and return its stdout text."""
    # Find the jar in engines/bim-generator/target
    current_dir = Path(__file__).resolve()
    # openbinding-gateway/src/openbinding_gateway/generator/synthesizer.py -> root is parents[4]
    repo_root = current_dir.parents[4]
    jar_path = repo_root / "engines" / "bim-generator" / "target" / "bim-generator-0.1.0-SNAPSHOT.jar"

    if not jar_path.is_file():
        raise FileNotFoundError(f"Legacy BIM generator jar not found at {jar_path}. Run mvn package in engines.")

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
    constraints: int = 1,
    target_engines: list[str] | None = None,
    optimization_mode: str | None = None,
    guarantee_feasibility: bool = True,
    tension: float = 0.7,
    name: str = "generated_instance",
    profile: str = "qos-binding/v1",
    dialects: list[str] | None = None,
    seed: int | None = None,
    use_legacy_engine: bool = False,
) -> InstancePackage:
    """Unified generator entrypoint producing a valid BIM v1 InstancePackage."""
    caps = resolve_engine_capabilities(target_engines)
    if optimization_mode:
        if optimization_mode not in caps.allowed_optimizations:
            from .compatibility import IncompatibleTargetEnginesError
            raise IncompatibleTargetEnginesError(
                f"Requested optimization mode {optimization_mode!r} not supported by target engines {target_engines}: allowed {caps.allowed_optimizations}",
                conflicts=[{"dimension": "optimization", "requested": optimization_mode, "allowed": caps.allowed_optimizations}],
            )
        caps.default_optimization = optimization_mode
        caps.default_objective_type = "MANY" if optimization_mode == "pareto" else "MONO"

    if use_legacy_engine:
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
            constraints=constraints,
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
    )

    return postprocessor.process(problem)
