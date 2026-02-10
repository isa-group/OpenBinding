# Literature Scenarios

This directory contains problem instances derived from academic literature in the field of QoS-aware Web Service Composition. These scenarios serve as standard benchmarks for evaluating the performance and correctness of composition engines.

## Sources

The instances are adapted from the following key papers and datasets:

*   **Benatallah et al. (2002)**: *Declarative Composition and Peer-to-Peer Provisioning of Dynamic Web Services*.
    *   **DOI**: [10.1109/ICDE.2002.994701](https://doi.org/10.1109/ICDE.2002.994701)
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

*   **Parejo et al. (2014)**: *QoS-aware Web Services Composition using GRASP with Path Relinking*.
    *   **DOI**: [10.1016/j.eswa.2013.12.036](https://doi.org/10.1016/j.eswa.2013.12.036)
    *   **Source**: Standard WSC-09 challenge datasets adapted to the JSON format.

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

Each JSON file represents a "Base Scenario". These base scenarios define the *structure* (Tasks, Composition) and *features* of the problem.

For experimentation, these base scenarios are typically **scaled up** using the `experimentation/generator.py` script, which:
1.  Multiplies the number of candidates per task to increase the binding space size.
2.  Varies the constraints and objectives to create diverse test instances.

## Usage

To use a base scenario directly:

```bash
curl -X POST "http://localhost:8000/v1/solve?engine=random-search" \
     -H "Content-Type: application/json" \
     -d @benatallah.json
```
