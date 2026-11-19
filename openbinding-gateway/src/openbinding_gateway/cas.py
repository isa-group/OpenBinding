"""Universidad de Sevilla CAS 2.0 validation (its one-time state lives in ``modules.identity``'s store)."""

from __future__ import annotations

from dataclasses import dataclass

from lxml import etree


@dataclass(frozen=True)
class CasPrincipal:
    subject: str
    attributes: dict[str, str]


def parse_service_validate(xml: bytes) -> CasPrincipal:
    """Parse a bounded CAS response with DTDs, entities and network disabled."""

    if len(xml) > 256 * 1024 or b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise ValueError("Unsafe or oversized CAS validation response")
    parser = etree.XMLParser(
        resolve_entities=False, load_dtd=False, no_network=True,
        recover=False, remove_comments=True, huge_tree=False,
    )
    try:
        root = etree.fromstring(xml, parser=parser)
    except etree.XMLSyntaxError as exc:
        raise ValueError("Malformed CAS validation response") from exc
    success = next((node for node in root.iter() if etree.QName(node).localname == "authenticationSuccess"), None)
    if success is None:
        failure = next((node for node in root.iter() if etree.QName(node).localname == "authenticationFailure"), None)
        detail = "CAS refused the ticket" if failure is None else " ".join("".join(failure.itertext()).split())
        raise ValueError(detail)
    user = next((node for node in success.iter() if etree.QName(node).localname == "user"), None)
    subject = "" if user is None else " ".join("".join(user.itertext()).split())
    if not subject or len(subject) > 160:
        raise ValueError("CAS response has no valid UVUS subject")
    attributes: dict[str, str] = {}
    container = next((node for node in success.iter() if etree.QName(node).localname == "attributes"), None)
    if container is not None:
        for child in container:
            key = etree.QName(child).localname.casefold()
            value = " ".join("".join(child.itertext()).split())
            if key and value:
                attributes[key] = value[:1000]
    return CasPrincipal(subject=subject, attributes=attributes)
