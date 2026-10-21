#!/usr/bin/env python3
"""Transform RPRSR15 benchmark instances (Ramirez et al. 2017 / Parejo et al. 2014) into BIM v1 packages.

Source: https://www.uco.es/grupos/kdis/sbse/RPRSR15/
Paper: Ramirez et al., 'Evolutionary composition of QoS-aware web services: a many-objective perspective',
       Expert Systems with Applications, 2017. DOI: 10.1016/j.eswa.2016.10.047.
Instance Generator: Parejo et al., 'QoS-aware web services composition using GRASP with path relinking',
       Expert Systems with Applications, 2014. DOI: 10.1016/j.eswa.2013.12.036.

Every instance file declares its own QoS model (``QoSModel{ Properties{...} AggregationFunctions(...)
Weights(...) }``), a composition structure made of ``SEC[...]``, ``BRANCH(p1;p2;...)[...]`` and
``LOOP(k)[...]`` blocks, and the candidate services (QWS measurements) of every abstract service.
This transformation reads all of it instead of assuming a fixed model:

* **Structure.** ``SEC`` -> sequence, ``BRANCH`` -> probabilistic exclusive choice with the declared
  branch probabilities (routing overlay), ``LOOP(k)`` -> exact repeat with count ``k``; an empty
  ``SEC[]`` branch is an empty flow.
* **Aggregation functions** (identical in the 60 released files): ``SUM``/``PRODUCT``/``MIN`` map to
  the BIM operators; ``SUMPOW`` (branch) is the probability-weighted sum, ``POW`` (branch) the
  probability-weighted product, loops scale additive attributes (``SUMPOW`` -> ``scale``) and raise
  multiplicative ones to the iteration count (``power``). ``AVG`` (documentation, best practices,
  compliance) is the mean of the children of each sequence/branch; it is lowered exactly by folding
  the constant ``1/|children|`` factors of every enclosing sequence into the candidate values of each
  abstract service (``avg_prescale`` annotation) and aggregating with ``sum``/``weightedSum``, so
  that the aggregated value is the nested mean. Loops leave ``MIN`` and ``AVG`` attributes unchanged
  (the declared ``SUMPOW`` would multiply an average by the iteration count).
* **Values.** Multiplicative attributes (availability, successability) are QWS percentages; they are
  rescaled to ``[0, 1]`` so that products are probabilities. Latency and response time are stored
  negated in the files (so that every attribute is "positive"); the absolute values are used and the
  attributes minimised.
* **Objective.** The source is a many-objective benchmark (every declared weight is 0). The BIM
  optimisation keeps the nine attributes as criteria with equal weights and normalises each one by
  its attained extremes over the composition (computed from the per-service best and worst
  candidates, which is exact because every aggregation is monotone in each service's value).
* **Constraints.** None of the released files declares constraints (``Number of Constraints: 0``).
"""
from __future__ import annotations

import argparse
from decimal import ROUND_HALF_EVEN, Decimal
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "openbinding-gateway/src"))

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import InstancePackage

ATTRIBUTES = {
    # file name -> (feature id, direction, percentage -> fraction?, negated in the file?)
    "Throughput": ("throughput", "maximize", False, False),
    "Availability": ("availability", "maximize", True, False),
    "Latency": ("latency", "minimize", False, True),
    "Documentation": ("documentation", "maximize", False, False),
    "Successability": ("successability", "maximize", True, False),
    "BestPractices": ("bestpractices", "maximize", False, False),
    "Reliability": ("reliability", "maximize", False, False),
    "ResponseTime": ("responsetime", "minimize", False, True),
    "Compliance": ("compliance", "maximize", False, False),
}
SEQUENCE_MAP = {"SUM": "sum", "PRODUCT": "product", "MIN": "min", "MAX": "max", "AVG": "sum"}
PARALLEL_MAP = {"SUM": "sum", "PRODUCT": "product", "MIN": "min", "MAX": "max", "AVG": "sum", "MINAVG": "min"}
BRANCH_MAP = {"SUMPOW": "weightedSum", "POW": "weightedProduct", "MIN": "min", "MAX": "max", "AVG": "weightedSum"}


def loop_operator(sequence_code: str) -> str:
    if sequence_code == "SUM":
        return "scale"
    if sequence_code == "PRODUCT":
        return "power"
    return "identity"  # MIN / AVG attributes are invariant under repetition


# ----------------------------------------------------------------------------- parsing

def parse_workflow(text: str) -> dict:
    """Parse the CompositionStructure block into a BIM workflow (with branch probabilities)."""
    text = re.sub(r"%.*", "", text)
    tokens = re.findall(r"SEC\[|BRANCH\([^)]*\)\[|LOOP\([^)]*\)\[|\]|,|\d+", text)
    pos = 0
    branch_counter = 0
    routing: dict[str, float] = {}

    def parse_node():
        nonlocal pos, branch_counter
        if pos >= len(tokens):
            return {"empty": True}
        tok = tokens[pos]
        if tok == "SEC[":
            pos += 1
            seq = []
            while pos < len(tokens) and tokens[pos] != "]":
                if tokens[pos] == ",":
                    pos += 1
                    continue
                child = parse_node()
                if child:
                    seq.append(child)
            if pos < len(tokens) and tokens[pos] == "]":
                pos += 1
            if not seq:
                return {"empty": True}
            if len(seq) == 1:
                return seq[0]
            return {"sequence": seq}
        if tok.startswith("BRANCH("):
            probabilities = [float(x) for x in tok[len("BRANCH("):-2].split(";") if x.strip()]
            pos += 1
            branches = []
            while pos < len(tokens) and tokens[pos] != "]":
                if tokens[pos] == ",":
                    pos += 1
                    continue
                child = parse_node()
                branch_counter += 1
                b_id = f"b_{branch_counter}"
                branches.append({"id": b_id, "flow": child or {"empty": True}})
            if pos < len(tokens) and tokens[pos] == "]":
                pos += 1
            if not branches:
                return {"empty": True}
            if len(probabilities) != len(branches) or abs(sum(probabilities) - 1.0) > 1e-9:
                raise ValueError(f"branch probabilities {probabilities} do not match {len(branches)} branches")
            for branch, probability in zip(branches, exact_decimal_probabilities(probabilities)):
                routing[branch["id"]] = probability
            return {"exclusive": branches}
        if tok.startswith("LOOP("):
            count = int(float(tok[len("LOOP("):-2]))
            pos += 1
            body = []
            while pos < len(tokens) and tokens[pos] != "]":
                if tokens[pos] == ",":
                    pos += 1
                    continue
                child = parse_node()
                if child:
                    body.append(child)
            if pos < len(tokens) and tokens[pos] == "]":
                pos += 1
            inner = {"empty": True} if not body else body[0] if len(body) == 1 else {"sequence": body}
            return {"repeat": {"count": count, "body": inner}}
        if re.match(r"^\d+$", tok):
            pos += 1
            return {"task": {"resource": "application", "id": f"t_{tok}"}}
        pos += 1
        return None

    node = parse_node()
    return {"workflow": node, "routing": routing}


def exact_decimal_probabilities(values: list[float]) -> list[float]:
    """Round branch probabilities to 12 decimals so that their decimal sum is exactly 1.

    The BIM compiler requires XOR probabilities whose decimal representations add up to exactly one;
    the generator prints 16-17 significant digits whose sum can differ from one by rounding.
    """
    quantum = Decimal(1).scaleb(-12)
    rounded = [Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_EVEN) for value in values]
    rounded[-1] = Decimal(1) - sum(rounded[:-1], Decimal(0))
    if any(value < 0 for value in rounded):
        raise ValueError(f"branch probabilities {values} cannot be normalised")
    return [float(value) for value in rounded]


def parse_qos_model(text: str) -> tuple[dict[str, dict[str, str]], dict[str, float]]:
    block = re.search(r"AggregationFunctions\((.*?)\)\s*Weights\((.*?)\)", text, re.DOTALL)
    if not block:
        raise ValueError("QoSModel aggregation functions not found")
    functions: dict[str, dict[str, str]] = {}
    for attribute, body in re.findall(r"(\w+)\{([^}]*)\}", block.group(1)):
        functions[attribute] = dict(re.findall(r"(\w+):(\w+)", body))
    weights = {attribute: float(value) for attribute, value in re.findall(r"(\w+):([\d.]+)", block.group(2))}
    return functions, weights


def avg_prescale(node: dict, factor: float, result: dict[str, float]) -> None:
    """Fold the 1/|children| factor of every enclosing sequence into each task (AVG attributes)."""
    if "task" in node:
        result[node["task"]["id"]] = result.get(node["task"]["id"], 0.0) + factor
    elif "sequence" in node:
        children = node["sequence"]
        for child in children:
            avg_prescale(child, factor / len(children), result)
    elif "exclusive" in node:
        for branch in node["exclusive"]:
            avg_prescale(branch["flow"], factor, result)  # probabilities are applied by weightedSum
    elif "repeat" in node:
        avg_prescale(node["repeat"]["body"], factor, result)  # identity under repetition


def workflow_tasks(node: dict, acc: list[str]) -> None:
    if "task" in node:
        acc.append(node["task"]["id"])
    elif "sequence" in node:
        for child in node["sequence"]:
            workflow_tasks(child, acc)
    elif "exclusive" in node:
        for branch in node["exclusive"]:
            workflow_tasks(branch["flow"], acc)
    elif "repeat" in node:
        workflow_tasks(node["repeat"]["body"], acc)


# ----------------------------------------------------------------------------- transformation

def transform_instance_text(name: str, raw: str) -> tuple[dict, InstancePackage]:
    m_wf = re.search(r"% CompositionStructure:\s*%\s*-+\s*(.*?)(?=%#|\Z)", raw, re.DOTALL)
    if not m_wf:
        raise ValueError(f"No CompositionStructure found in {name}")
    parsed = parse_workflow(m_wf.group(1).strip())
    wf_node = parsed["workflow"]
    routing = parsed["routing"]
    functions, declared_weights = parse_qos_model(raw)
    constraints_header = re.search(r"Number of Constraints:\s*(\d+)", raw)
    if constraints_header and int(constraints_header.group(1)) != 0:
        raise ValueError(f"{name}: constrained RPRSR15 instances are not supported by this transformation")

    cand_sec = raw.split("%#======================= CANDIDATE SERVICES =============================#")[1].split("%#======================= CONSTRAINTS =============================#")[0]
    cand_blocks = re.split(r"-{10,}\s*(\d+)\s*-{10,}", cand_sec)

    used_tasks: list[str] = []
    workflow_tasks(wf_node, used_tasks)
    if len(used_tasks) != len(set(used_tasks)):
        raise ValueError(f"{name}: an abstract service appears more than once in the structure")
    prescale: dict[str, float] = {}
    avg_prescale(wf_node, 1.0, prescale)

    feature_defs: dict[str, dict] = {}
    for attribute, (feature_id, direction, fraction, _negated) in ATTRIBUTES.items():
        codes = functions[attribute]
        sequence_code = codes["Sequence"]
        aggregation = {
            "sequence": SEQUENCE_MAP[sequence_code],
            "parallel": PARALLEL_MAP[codes["Flow"]],
            "exclusive": BRANCH_MAP[codes["Branch"]],
            "repeat": loop_operator(sequence_code),
        }
        if fraction:
            domain = {"kind": "ratio", "minimum": 0.0, "maximum": 1.0}
        elif direction == "minimize":
            domain = {"kind": "real", "minimum": 0.0, "maximum": 100000.0}
        else:
            domain = {"kind": "real", "minimum": 0.0, "maximum": 100.0}
        feature_defs[feature_id] = {
            "direction": direction,
            "scope": "invocation",
            "aggregation": aggregation,
            "neutral": 1.0 if sequence_code == "PRODUCT" else 0.0,
            "domain": domain,
        }
        if sequence_code == "MIN":
            # An empty branch must not pull a minimum down to zero.
            feature_defs[feature_id]["neutral"] = 100.0

    tasks_in_cand = set(cand_blocks[i].strip() for i in range(1, len(cand_blocks), 2))
    candidates = {}
    providers = {}
    for i in range(1, len(cand_blocks), 2):
        task_num = cand_blocks[i].strip()
        task_id = f"t_{task_num}"
        if task_id not in used_tasks:
            continue
        lines = cand_blocks[i + 1].strip().splitlines()
        for line_idx, line in enumerate(lines):
            line = line.strip()
            if not line or "(" not in line:
                continue
            svc_name, attrs_part = line.split("(", 1)
            svc_name = svc_name.strip()
            attrs_part = attrs_part.rstrip("),")
            qos: dict[str, float] = {}
            for pair in attrs_part.split(","):
                if ":" not in pair:
                    continue
                k, v = pair.split(":", 1)
                attribute = k.strip()
                if attribute not in ATTRIBUTES:
                    continue
                feature_id, _direction, fraction, negated = ATTRIBUTES[attribute]
                value = float(v.strip())
                if negated:
                    value = abs(value)
                if fraction:
                    value = value / 100.0
                if functions[attribute]["Sequence"] == "AVG":
                    value = value * prescale.get(task_id, 1.0)
                qos[feature_id] = value
            if set(qos) != set(feature_defs):
                raise ValueError(f"{name}: candidate {svc_name!r} of {task_id} lacks attributes {sorted(set(feature_defs) - set(qos))}")
            cand_id = f"c_{task_num}_{line_idx}"
            prov_id = f"p_{re.sub(r'[^A-Za-z0-9_]+', '_', svc_name)}"[:60]
            providers[prov_id] = {}
            candidates[cand_id] = {
                "provides": f"service/{task_id}",
                "provider": {"resource": "catalog", "id": prov_id},
                "features": qos,
            }
    missing = [task for task in used_tasks if task.split("_", 1)[1] not in tasks_in_cand]
    if missing:
        raise ValueError(f"{name}: structure references abstract services without candidates: {missing}")

    tasks_dict = {task: f"service/{task}" for task in sorted(used_tasks, key=lambda t: int(t.split('_', 1)[1]))}

    has_exclusive = bool(routing)
    resources = {
        "application": {"application": "application.json"},
        "candidateCatalog": {"catalog": "candidates.json"},
        "constraintSet": {"constraints": "constraints.json"},
        "optimization": {"optimization": "optimization.json"},
    }
    if has_exclusive:
        resources["candidateCatalog"]["routing"] = "routing.json"

    app = {
        "apiVersion": "qos-binding/v1",
        "kind": "Application",
        "metadata": {"name": f"{name}_application"},
        "spec": {"tasks": tasks_dict, "features": feature_defs, "workflow": wf_node},
    }
    cat = {
        "apiVersion": "qos-binding/v1",
        "kind": "CandidateCatalog",
        "metadata": {"name": f"{name}_catalog"},
        "spec": {
            "providers": providers,
            "featureBindings": {k: {"resource": "application", "id": k} for k in feature_defs},
            "candidates": candidates,
        },
    }
    cons = {
        "apiVersion": "qos-binding/v1",
        "kind": "ConstraintSet",
        "metadata": {"name": f"{name}_constraints"},
        "spec": {"constraints": {}},
    }
    files = {
        "application.json": (json.dumps(app, indent=2, sort_keys=True) + "\n").encode(),
        "candidates.json": (json.dumps(cat, indent=2, sort_keys=True) + "\n").encode(),
        "constraints.json": (json.dumps(cons, indent=2, sort_keys=True) + "\n").encode(),
    }
    if has_exclusive:
        rt = {
            "apiVersion": "qos-binding/v1",
            "kind": "RoutingOverlay",
            "metadata": {"name": f"{name}_routing"},
            "spec": {"entries": [{"target": {"resource": "application", "id": branch_id}, "probability": probability}
                                 for branch_id, probability in routing.items()]},
        }
        files["routing.json"] = (json.dumps(rt, indent=2, sort_keys=True) + "\n").encode()

    # Attained extremes: evaluate the per-service best and worst candidates through the compiler
    # (every aggregation is monotone in each service's value, so these are the exact extremes).
    probe_opt = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": f"{name}_optimization"},
        "spec": {"criteria": [{"id": k, "feature": {"resource": "application", "id": k}, "direction": feature_defs[k]["direction"]} for k in feature_defs]},
    }
    probe_inst = _instance_document(name, resources, {})
    probe_files = dict(files)
    probe_files["instance.json"] = (json.dumps(probe_inst, indent=2, sort_keys=True) + "\n").encode()
    probe_files["optimization.json"] = (json.dumps(probe_opt, indent=2, sort_keys=True) + "\n").encode()
    problem = compile_instance(InstancePackage(probe_files))
    by_task: dict[str, list[tuple[str, dict]]] = {}
    for cand_id, cand in candidates.items():
        by_task.setdefault(cand["provides"].split("/", 1)[1], []).append((cand_id, cand["features"]))
    extremes: dict[str, list[float]] = {}
    for feature_id in feature_defs:
        bounds = []
        for pick in (min, max):
            binding = {}
            for task in tasks_dict:
                cand_id, _features = pick(by_task[task], key=lambda item: item[1][feature_id])
                binding[task] = {"resource": "catalog", "id": cand_id}
            bounds.append(float(problem.evaluate_binding(binding)[feature_id]))
        extremes[feature_id] = [min(bounds), max(bounds)]

    opt = {
        "apiVersion": "qos-binding/v1",
        "kind": "Optimization",
        "metadata": {"name": f"{name}_optimization"},
        "spec": {
            "criteria": [
                {
                    "id": k,
                    "feature": {"resource": "application", "id": k},
                    "direction": feature_defs[k]["direction"],
                    "normalize": {
                        "min": extremes[k][0],
                        "max": extremes[k][1] if extremes[k][1] > extremes[k][0] else extremes[k][0] + 1.0,
                        "clamp": False,
                    },
                }
                for k in feature_defs
            ]
        },
    }
    annotations = {
        "source": "https://www.uco.es/grupos/kdis/sbse/RPRSR15/",
        "source_file": name,
        "paper": {
            "authors": "A. Ramirez, J. A. Parejo, J. R. Romero, S. Segura, A. Ruiz-Cortes",
            "title": "Evolutionary composition of QoS-aware web services: a many-objective perspective",
            "journal": "Expert Systems with Applications",
            "volume": 72,
            "pages": "357-370",
            "year": 2017,
            "doi": "10.1016/j.eswa.2016.10.047",
        },
        "generator_paper": {
            "authors": "J. A. Parejo, S. Segura, P. Fernandez, A. Ruiz-Cortes",
            "title": "QoS-aware web services composition using GRASP with path relinking",
            "journal": "Expert Systems with Applications",
            "volume": 41,
            "number": 9,
            "pages": "4211-4223",
            "year": 2014,
            "doi": "10.1016/j.eswa.2013.12.036",
        },
        "source_license": "Academic / Research Open Benchmark",
        "source_aggregation_functions": functions,
        "source_weights": declared_weights,
        "objective_weights": {k: 1.0 for k in feature_defs},
        "objective_note": "many-objective source (all declared weights are 0); QACOBench optimises the equal-weight sum of losses normalised by the attained extremes",
        "attained_extremes": extremes,
        "avg_prescale": {task: prescale.get(task, 1.0) for task in tasks_dict},
        "value_conventions": {
            "availability": "QWS percentage / 100",
            "successability": "QWS percentage / 100",
            "latency": "absolute value of the negated source attribute",
            "responsetime": "absolute value of the negated source attribute",
            "documentation": "source value * avg_prescale[task] (nested mean folded into the candidate)",
            "bestpractices": "source value * avg_prescale[task] (nested mean folded into the candidate)",
            "compliance": "source value * avg_prescale[task] (nested mean folded into the candidate)",
        },
        "loop_semantics": "LOOP(k): additive attributes scaled by k, multiplicative attributes raised to k, MIN and AVG attributes unchanged",
        "branch_probabilities": "source values rounded to 12 decimals (last branch absorbs the rounding) so that each XOR sums exactly to 1",
    }
    inst = _instance_document(name, resources, annotations)
    files["instance.json"] = (json.dumps(inst, indent=2, sort_keys=True) + "\n").encode()
    files["optimization.json"] = (json.dumps(opt, indent=2, sort_keys=True) + "\n").encode()
    return inst, InstancePackage(files)


def _instance_document(name: str, resources: dict, annotations: dict) -> dict:
    return {
        "apiVersion": "bim/v1",
        "kind": "Instance",
        "metadata": {
            "name": name,
            "version": "2.0.0",
            "description": f"RPRSR15 many-objective QoS-aware service composition benchmark instance: {name}",
            "annotations": annotations,
        },
        "spec": {"profile": "qos-binding/v1", "resources": resources},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=ROOT / "datasets/sources/rprsr15", help="Path to uncompressed rprsr15 directory or zip file")
    parser.add_argument("--target-dir", type=Path, default=ROOT / "datasets/04_rprsr15", help="Destination directory for transformed packages")
    args = parser.parse_args()

    if not args.source.exists():
        raise SystemExit(f"Source not found: {args.source}")

    args.target_dir.mkdir(parents=True, exist_ok=True)

    entries: list[tuple[str, str, str]] = []  # (exp, base, text_content)
    if args.source.is_dir():
        for tp in sorted(args.source.glob("**/*.txt")):
            entries.append((tp.parent.name, tp.stem, tp.read_text(encoding="latin1")))
    else:
        zf = zipfile.ZipFile(args.source)
        for path_in_zip in sorted(f for f in zf.namelist() if f.endswith(".txt")):
            fn = Path(path_in_zip)
            entries.append((fn.parent.name, fn.stem, zf.read(path_in_zip).decode("latin1")))

    print(f"Transforming {len(entries)} RPRSR15 instances into {args.target_dir}...")
    compiled_count = 0
    for exp, base, raw in entries:
        inst_name = f"rprsr15_{exp}_{base}".replace("-", "_")
        _, pkg = transform_instance_text(inst_name, raw)
        compile_instance(pkg)
        out_dir = args.target_dir / inst_name
        out_dir.mkdir(parents=True, exist_ok=True)
        for stale in out_dir.iterdir():
            if stale.is_file() and stale.name not in pkg.files:
                stale.unlink()
        for rel_path, content in pkg.files.items():
            (out_dir / rel_path).write_bytes(content)
        compiled_count += 1

    print(f"Successfully transformed and compiled {compiled_count}/{len(entries)} RPRSR15 instances!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
