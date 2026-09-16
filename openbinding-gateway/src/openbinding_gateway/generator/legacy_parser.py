"""Parser for legacy QACO problem files."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Union


@dataclass
class StructureNode:
    kind: str  # "task", "sequence", "branch", "loop", "flow", "empty"
    id: str | None = None
    children: list[StructureNode] = field(default_factory=list)
    probabilities: list[float] = field(default_factory=list)
    iterations: int = 1


@dataclass
class QoSPropertySpec:
    name: str
    direction: str  # "minimize" or "maximize"
    domain_min: float = 0.0
    domain_max: float = 1.0
    weight: float = 1.0
    aggregations: dict[str, str] = field(default_factory=dict)


@dataclass
class CandidateService:
    name: str
    metrics: dict[str, float] = field(default_factory=dict)


@dataclass
class LegacyConstraint:
    property_name: str
    operator: str  # "<=", ">=", "==", "<", ">"
    value: float


@dataclass
class LegacyProblem:
    abstract_services: list[str]
    structure: StructureNode
    qos_properties: dict[str, QoSPropertySpec]
    candidates: dict[str, list[CandidateService]]
    constraints: list[LegacyConstraint]
    metadata: dict[str, Any] = field(default_factory=dict)


def _decode_content(raw: Union[str, bytes]) -> str:
    if isinstance(raw, str):
        return raw
    for enc in ("utf-8", "latin-1", "cp1252", "iso-8859-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def _tokenize_structure(text: str) -> list[str]:
    clean_lines = [line for line in text.splitlines() if not line.strip().startswith("%")]
    clean_text = "\n".join(clean_lines)
    return re.findall(r"[A-Za-z0-9_.-]+|[()\[\],;]", clean_text)


class _StructureParser:
    def __init__(self, tokens: list[str]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def next_token(self) -> str:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self) -> StructureNode:
        if self.pos >= len(self.tokens):
            return StructureNode(kind="empty")
        tok = self.next_token()

        if tok in ("SEC", "SEQUENCE"):
            if self.peek() == "[":
                self.next_token()
            children: list[StructureNode] = []
            while self.peek() is not None and self.peek() != "]":
                if self.peek() == ",":
                    self.next_token()
                    continue
                child = self.parse()
                children.append(child)
                if self.peek() == ",":
                    self.next_token()
            if self.peek() == "]":
                self.next_token()
            return StructureNode(kind="sequence", children=children)

        if tok == "FLOW":
            if self.peek() == "[":
                self.next_token()
            children = []
            while self.peek() is not None and self.peek() != "]":
                if self.peek() == ",":
                    self.next_token()
                    continue
                child = self.parse()
                children.append(child)
                if self.peek() == ",":
                    self.next_token()
            if self.peek() == "]":
                self.next_token()
            return StructureNode(kind="flow", children=children)

        if tok == "LOOP":
            iters = 1
            if self.peek() == "(":
                self.next_token()
                iters_str = self.next_token()
                try:
                    iters = int(iters_str)
                except ValueError:
                    iters = int(float(iters_str))
                if self.peek() == ")":
                    self.next_token()
            if self.peek() == "[":
                self.next_token()
            children = []
            while self.peek() is not None and self.peek() != "]":
                if self.peek() == ",":
                    self.next_token()
                    continue
                child = self.parse()
                children.append(child)
                if self.peek() == ",":
                    self.next_token()
            if self.peek() == "]":
                self.next_token()
            return StructureNode(kind="loop", iterations=iters, children=children)

        if tok == "BRANCH":
            probs: list[float] = []
            if self.peek() == "(":
                self.next_token()
                while self.peek() is not None and self.peek() != ")":
                    if self.peek() == ";":
                        self.next_token()
                        continue
                    prob_str = self.next_token()
                    try:
                        probs.append(float(prob_str))
                    except ValueError:
                        pass
                    if self.peek() == ";":
                        self.next_token()
                if self.peek() == ")":
                    self.next_token()

            if self.peek() == "[":
                self.next_token()
            children = []
            while self.peek() is not None and self.peek() != "]":
                if self.peek() == ",":
                    self.next_token()
                    continue
                child = self.parse()
                children.append(child)
                if self.peek() == ",":
                    self.next_token()
            if self.peek() == "]":
                self.next_token()
            return StructureNode(kind="branch", probabilities=probs, children=children)

        # Leaf task
        return StructureNode(kind="task", id=tok)


def parse_legacy_structure(text: str) -> StructureNode:
    tokens = _tokenize_structure(text)
    parser = _StructureParser(tokens)
    return parser.parse()


def parse_legacy_file(content_or_path: Union[str, bytes]) -> LegacyProblem:
    """Parse a legacy QACO text specification into a structured LegacyProblem."""
    raw_text: str
    if isinstance(content_or_path, (str, bytes)):
        # Check if content_or_path is an existing filepath
        if isinstance(content_or_path, str) and "\n" not in content_or_path:
            import os
            if os.path.isfile(content_or_path):
                with open(content_or_path, "rb") as f:
                    raw_text = _decode_content(f.read())
            else:
                raw_text = _decode_content(content_or_path)
        else:
            raw_text = _decode_content(content_or_path)
    else:
        raise ValueError(f"Unsupported content type: {type(content_or_path)}")

    sections_split = re.split(r"%#=+\s*([A-Z ]+)\s*=+#", raw_text)
    sections: dict[str, str] = {}
    for i in range(1, len(sections_split), 2):
        sections[sections_split[i].strip()] = sections_split[i + 1]

    # 1. Header & Statistics
    header_sec = sections.get("HEADER", "")
    metadata: dict[str, Any] = {}
    for line in header_sec.splitlines():
        line = line.strip()
        if line.startswith("% Number of activities:"):
            metadata["activities"] = int(line.split(":")[-1].strip())
        elif line.startswith("% Number of Candidate Services:"):
            metadata["candidates"] = int(line.split(":")[-1].strip())
        elif line.startswith("% Number of Constraints:"):
            metadata["constraints"] = int(line.split(":")[-1].strip())

    # 2. Composition Structure
    struct_sec = sections.get("COMPOSITION STRUCTURE", "")
    abstract_services: list[str] = []
    struct_text = ""

    if "% Abstract Services:" in struct_sec and "% CompositionStructure:" in struct_sec:
        parts = struct_sec.split("% CompositionStructure:")
        aws_part = parts[0].split("% Abstract Services:")[-1]
        struct_text = parts[1]

        aws_lines = [line.strip() for line in aws_part.splitlines() if line.strip() and not line.strip().startswith("%") and not line.strip().startswith("-")]
        if aws_lines:
            # First line may be count
            try:
                _count = int(aws_lines[0])
                abstract_services = aws_lines[1:]
            except ValueError:
                abstract_services = aws_lines
    else:
        struct_text = struct_sec

    structure_node = parse_legacy_structure(struct_text)

    # 3. QoS Model
    qos_sec = sections.get("QOS MODEL", "")
    qos_props: dict[str, QoSPropertySpec] = {}

    props_m = re.search(r"Properties\s*\{([^}]+)\}", qos_sec, re.DOTALL)
    if props_m:
        for line in props_m.group(1).splitlines():
            line = line.strip()
            if not line:
                continue
            m = re.match(
                r"([A-Za-z0-9_]+)\s*:\s*(POSITIVE|NEGATIVE)[^\d\[]*\[\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*\]",
                line,
            )
            if m:
                pname, ptype, pmin, pmax = m.groups()
                qos_props[pname] = QoSPropertySpec(
                    name=pname,
                    direction="maximize" if ptype == "POSITIVE" else "minimize",
                    domain_min=float(pmin),
                    domain_max=float(pmax),
                )

    aggr_m = re.search(r"AggregationFunctions\s*\((.*?)\)\s*(?:Weights|$)", qos_sec, re.DOTALL)
    if aggr_m:
        aggr_block = aggr_m.group(1)
        for p_block in re.finditer(r"([A-Za-z0-9_]+)\s*\{([^}]+)\}", aggr_block):
            pname = p_block.group(1)
            body = p_block.group(2)
            if pname in qos_props:
                aggs = {}
                for line in body.splitlines():
                    if ":" in line:
                        ctx, op = line.strip().split(":", 1)
                        aggs[ctx.strip().lower()] = op.strip().lower()
                qos_props[pname].aggregations = aggs

    weights_m = re.search(r"Weights\s*\((.*?)\)", qos_sec, re.DOTALL)
    if weights_m:
        for line in weights_m.group(1).splitlines():
            if ":" in line:
                pname, w = line.strip().split(":", 1)
                pname = pname.strip()
                if pname in qos_props:
                    try:
                        qos_props[pname].weight = float(w.strip())
                    except ValueError:
                        pass

    # 4. Candidate Services
    cand_sec = sections.get("CANDIDATE SERVICES", "")
    chunks = re.split(r"-{10,}", cand_sec)
    candidates: dict[str, list[CandidateService]] = {}
    i = 0
    while i < len(chunks):
        chunk = chunks[i].strip()
        if not chunk:
            i += 1
            continue
        lines = [l.strip() for l in chunk.splitlines() if l.strip()]
        if len(lines) == 1 and "(" not in lines[0]:
            task_name = lines[0]
            if i + 1 < len(chunks):
                cand_lines = [l.strip() for l in chunks[i + 1].splitlines() if l.strip()]
                cands: list[CandidateService] = []
                for cline in cand_lines:
                    m = re.match(r"([A-Za-z0-9_.-]+)\s*\((.*)\)", cline)
                    if m:
                        cname = m.group(1)
                        raw_metrics = m.group(2)
                        metrics: dict[str, float] = {}
                        for item in raw_metrics.split(","):
                            if ":" in item:
                                k, v = item.split(":", 1)
                                try:
                                    metrics[k.strip()] = float(v.strip())
                                except ValueError:
                                    pass
                        cands.append(CandidateService(name=cname, metrics=metrics))
                candidates[task_name] = cands
                i += 2
                continue
        i += 1

    # 5. Constraints
    constr_sec = sections.get("CONSTRAINTS", "")
    constraints: list[LegacyConstraint] = []
    op_map = {
        "GREATEREQUAL": ">=",
        "LOWEREQUAL": "<=",
        "EQUAL": "==",
        "GREATER": ">",
        "LOWER": "<",
    }
    for line in constr_sec.splitlines():
        line = line.strip()
        if not line or line.startswith("%") or line.isdigit():
            continue
        m = re.match(r"([A-Z]+)\s*\(\s*([A-Za-z0-9_]+)\s*,\s*([0-9.eE+-]+)\s*\)", line)
        if m:
            op_name, prop_name, val_str = m.groups()
            mapped_op = op_map.get(op_name, "<=")
            constraints.append(
                LegacyConstraint(
                    property_name=prop_name,
                    operator=mapped_op,
                    value=float(val_str),
                )
            )

    return LegacyProblem(
        abstract_services=abstract_services,
        structure=structure_node,
        qos_properties=qos_props,
        candidates=candidates,
        constraints=constraints,
        metadata=metadata,
    )


def parse_legacy_text(text: str) -> LegacyProblem:
    """Parse legacy QACO problem text."""
    return parse_legacy_file(text)

