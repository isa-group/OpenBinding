# Literature Scenarios

This directory contains problem instances derived from academic literature in the field of QoS-aware Web Service Composition. The selection of these scenarios is guided by the literature analysis and characterization reported in **Pesl et al.**, *Uncovering LLMs for Service-Composition: Challenges and Opportunities*, which identifies them as representative examples for the area.

## Sources

The instances are adapted from the following key papers and datasets:

*   **Pesl et al.**: *Uncovering LLMs for Service-Composition: Challenges and Opportunities*.
    *   **DOI**: [10.1007/978-981-97-0989-2_4](https://doi.org/10.1007/978-981-97-0989-2_4)
    *   **Authors**: Robin D. Pesl, Miles Stötzner, Ilche Georgievski & Marco Aiello.
    *   **Note**: This work reviews the service-composition literature and highlights these scenarios as representative examples used across prior research.

*   **Benatallah et al. (2002)**: *Declarative Composition and Peer-to-Peer Provisioning of Dynamic Web Services*.
    *   **DOI**: [10.1109/ICDE.2002.994738](https://doi.org/10.1109/ICDE.2002.994738)
    *   **Source**: Derived from the "Travel Solution" motivating example (CTS and ITAS statecharts).

*   **Bultan et al. (2003)**: *Conversation Specification: A New Approach to Design and Analysis of Web Service Composition*.
    *   **DOI**: [10.1145/775152.775210](https://doi.org/10.1145/775152.775210)
    *   **Source**: E-commerce purchase workflow.

*   **Cremaschi et al. (2018)**: *A Practical Approach to Services Composition Through Light Semantic Descriptions*.
    *   **DOI**: [10.1007/978-3-319-99819-0_10](https://doi.org/10.1007/978-3-319-99819-0_10)
    *   **Source**: A healthcare workflow involving patient monitoring and emergency response.

*   **Netedu et al. (2020)**: *A Web Service Composition Method Based on OpenAPI Semantic Annotations*.
    *   **DOI**: [10.1007/978-3-030-34986-8_25](https://doi.org/10.1007/978-3-030-34986-8_25)
    *   **Source**: Transport Agency case study.

*   **Pautasso (2009)**: *RESTful Web service composition with BPEL for REST*.
    *   **DOI**: [10.1016/j.datak.2009.02.016](https://doi.org/10.1016/j.datak.2009.02.016)
    *   **Source**: E-commerce scenario.

*   **Zeng et al. (2004)**: *QoS-Aware Middleware for Web Services Composition*.
    *   **DOI**: [10.1109/TSE.2004.11](https://doi.org/10.1109/TSE.2004.11)
    *   **Source**: One of the seminal papers introducing global optimization for service composition.

*   **Zhang et al. (2014)**: *Context-aware Generic Service Discovery and Service Composition*.
    *   **DOI**: [10.1109/MobServ.2014.27](https://doi.org/10.1109/MobServ.2014.27)
    *   **Source**: Personal Entertainment Planner.

## Structure

Each directory is a BIM v1 `Instance` with modular application,
candidate, constraint, and optimization resources. The workflow is native v1
JSON and task references use explicit `{resource,id}` objects. QoS values are
finite deterministic scalars; these scenarios do not encode scheduling or
uncertainty.

## Usage

Export a scenario directory as a deterministic `.bim.zip`, then submit the
complete package. For example:

```bash
curl -X POST "http://localhost:8000/v1/jobs" \
     -H "Content-Type: application/vnd.bim+zip" \
     -H "Idempotency-Key: literature-benatallah" \
     --data-binary @benatallah.bim.zip
```

The direct ZIP form uses the default compatible Engine mode. Create a snapshot
with `POST /v1/instances` and submit
`{ "snapshot": "...", "engine": "...", "mode": "...", "options": {...} }`
to select a different mode. The API never treats `instance.json` alone as the
whole scenario.
