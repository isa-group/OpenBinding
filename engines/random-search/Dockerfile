FROM maven:3.8-openjdk-8 as builder
WORKDIR /app
COPY pom.xml .
COPY src ./src
# COPY lib ./lib # No lib present or empty
RUN mvn package -DskipTests

FROM eclipse-temurin:8-jre
WORKDIR /app
COPY --from=builder /app/target/ManyObjectivesQoSawareCWSBinding-0.0.1-SNAPSHOT.jar app.jar
COPY --from=builder /app/target/dependency /app/dependency
EXPOSE 8080
CMD ["java", "-cp", "app.jar:dependency/*", "es.us.isa.qosawarewsbinding.api.Server"]
