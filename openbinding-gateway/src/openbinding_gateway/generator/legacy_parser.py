"""Parser for legacy QACO problem files."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Union


class LegacyParseError(ValueError):
    """The text handed to the parser is not a legacy QACO specification."""


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
    features: dict[str, float] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.metrics and not self.features:
            self.features = dict(self.metrics)
        elif self.features and not self.metrics:
            self.metrics = dict(self.features)


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


def parse_legacy_file(content: Union[str, bytes]) -> LegacyProblem:
    """Parse a legacy QACO text specification into a structured LegacyProblem.

    The argument is always the specification itself, never a path to it. Reading a
    file is the separate, explicitly named :func:`parse_legacy_path`, so that a
    string arriving from an untrusted caller - an HTTP request body, say - cannot
    make this function open whatever the string happens to name on the host.

    Raises:
        LegacyParseError: the text is not a legacy QACO specification.
    """
    if not isinstance(content, (str, bytes)):
        raise LegacyParseError(f"Unsupported content type: {type(content)}")
    raw_text = _decode_content(content)

    sections_split = re.split(r"%#=+\s*([A-Z ]+)\s*=+#", raw_text)
    sections: dict[str, str] = {}
    for i in range(1, len(sections_split), 2):
        sections[sections_split[i].strip()] = sections_split[i + 1]

    # Without a single section marker there is nothing of the grammar to read. The
    # parser would otherwise carry on over an empty structure and return a problem
    # that says more about its own defaults than about the input, which is how a
    # failed parse used to reach the caller looking like a successful one.
    if not sections:
        raise LegacyParseError(
            "no '%#= SECTION =#' marker found: the text is not a legacy QACO specification"
        )

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
        lines = [ln.strip() for ln in chunk.splitlines() if ln.strip()]
        if len(lines) == 1 and "(" not in lines[0]:
            task_name = lines[0]
            if i + 1 < len(chunks):
                cand_lines = [ln.strip() for ln in chunks[i + 1].splitlines() if ln.strip()]
                cands: list[CandidateService] = []
                for cline in cand_lines:
                    m = re.match(r"([A-Za-z0-9_.-]+)\s*\((.*)\)", cline)
                    if m:
                        cname = m.group(1)
                        raw_features = m.group(2)
                        features: dict[str, float] = {}
                        for item in raw_features.split(","):
                            if ":" in item:
                                k, v = item.split(":", 1)
                                try:
                                    features[k.strip()] = float(v.strip())
                                except ValueError:
                                    pass
                        cands.append(CandidateService(name=cname, features=features))
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


def parse_legacy_path(path: Union[str, os.PathLike[str]]) -> LegacyProblem:
    """Parse a legacy QACO specification held in a local file.

    This is for callers that already hold a trusted path of their own choosing - a
    command line, a test fixture - and it is deliberately not what the HTTP routes
    call: a request body is content, and only content.
    """
    with open(path, "rb") as handle:
        return parse_legacy_file(handle.read())

