FROM maven:3.9.9-eclipse-temurin-21@sha256:3a4ab3276a087bf276f79cae96b1af04f53731bec53fb2e651aca79e4b10211e AS builder
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY HTTPS_PROXY=$HTTPS_PROXY NO_PROXY=$NO_PROXY
WORKDIR /app
# The build context is engines/, so the shared BIM v1 evaluator can be built
# and installed before the search service that depends on it.
COPY binding-core ./binding-core
RUN cd /app/binding-core && mvn -B -q -DskipTests install

COPY evolutionary-heuristics/pom.xml ./evolutionary-heuristics/pom.xml
WORKDIR /app/evolutionary-heuristics
RUN mvn -B dependency:go-offline
COPY evolutionary-heuristics/src ./src
RUN mvn -B package

FROM eclipse-temurin:21-jre@sha256:d7051a45dd955e4d5d1db4d3f4269fe13d1c6dff8cc6b7ef89fc8577b96c1982
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/evolutionary-heuristics/target/evolutionary-heuristics-0.1.0-SNAPSHOT.jar /app/app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
