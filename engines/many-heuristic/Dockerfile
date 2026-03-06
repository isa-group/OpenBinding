FROM maven:3.8-openjdk-8 as builder
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV HTTP_PROXY=$HTTP_PROXY \
	HTTPS_PROXY=$HTTPS_PROXY \
	NO_PROXY=$NO_PROXY \
	http_proxy=$HTTP_PROXY \
	https_proxy=$HTTPS_PROXY \
	no_proxy=$NO_PROXY

WORKDIR /app
COPY pom.xml .
COPY src ./src
# COPY lib ./lib # No lib present or empty
RUN mvn -DskipTests \
  -Djava.net.preferIPv4Stack=true -Djava.net.preferIPv6Addresses=false \
  -Dhttp.proxyHost=$(echo "$HTTP_PROXY"  | sed -E 's#^https?://([^:/]+).*$#\1#') \
  -Dhttp.proxyPort=$(echo "$HTTP_PROXY"  | sed -E 's#^https?://[^:/]+:([0-9]+).*$#\1#') \
  -Dhttps.proxyHost=$(echo "$HTTPS_PROXY" | sed -E 's#^https?://([^:/]+).*$#\1#') \
  -Dhttps.proxyPort=$(echo "$HTTPS_PROXY" | sed -E 's#^https?://[^:/]+:([0-9]+).*$#\1#') \
  -Dhttp.nonProxyHosts="localhost|127.0.0.1|*.int.local|10.*|192.168.*|172.16.*" \
  package

FROM eclipse-temurin:8-jre
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=$HTTP_PROXY \
	HTTPS_PROXY=$HTTPS_PROXY \
	NO_PROXY=$NO_PROXY \
	http_proxy=$HTTP_PROXY \
	https_proxy=$HTTPS_PROXY \
	no_proxy=$NO_PROXY

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/ManyHeuristicQoSawareCWSBinding-0.0.1-SNAPSHOT.jar app.jar
COPY --from=builder /app/target/dependency /app/dependency
EXPOSE 8080
CMD ["java", "-cp", "app.jar:dependency/*", "es.us.isa.qosawarewsbinding.api.Server"]
