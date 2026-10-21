package es.us.isa.openbinding.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * HTTP side of the optional asynchronous mode of the JVM engines.
 *
 * <p>By default ({@code ENGINE_JOB_MODE} unset or {@code sync}) nothing changes: the engine's own
 * handler answers {@code POST /internal/v1/binding-problems} with {@code 200} and the result, and
 * there are no job endpoints.  With {@code ENGINE_JOB_MODE=async} the same POST answers {@code 202}
 * with a job id and these endpoints are mounted:</p>
 *
 * <ul>
 *   <li>{@code GET /internal/v1/jobs/{id}}: the {@code EngineJob} of the bim-engine/v1 contract.
 *       The contract has four states, so {@code cancelling} is shown as {@code running} and
 *       {@code cancelled} as {@code failed} with an error that starts with {@code cancelled:}.</li>
 *   <li>{@code DELETE /internal/v1/jobs/{id}}: an extension that the contract does not define,
 *       advertised by {@code extensions.cancellation} in {@code /openapi.json}.  {@code 200} with
 *       {@code {id,status}} when the solver is confirmed stopped (or the job was already final),
 *       {@code 202 {id,status:"cancelling"}} while it is still alive, {@code 404} for an unknown,
 *       expired or foreign id.</li>
 * </ul>
 *
 * <p>{@code ENGINE_AUTH_TOKENS='tenant=token,...'} turns on bearer authentication; a job belongs to
 * the tenant of the token that submitted it.  Without it the engine is open, as before.</p>
 */
public final class EngineHttp {
  public static final String SUBMIT_PATH = "/internal/v1/binding-problems";
  public static final String JOBS_PATH = "/internal/v1/jobs/";
  public static final String OPENAPI_PATH = "/openapi.json";

  private static final long MAX_BODY_BYTES = 64L * 1024L * 1024L;
  private static final Pattern JOB_ID = Pattern.compile("[A-Za-z0-9-]{1,64}");

  private EngineHttp() {}

  /** An engine: validates a payload and returns the work that solves it. */
  public interface Engine {
    /**
     * Validates the whole request (shape, options, objective class).  Throws
     * {@link IllegalArgumentException} for anything the engine would answer with 422, so that an
     * invalid request is refused before a job exists.
     */
    EngineJobs.Work prepare(String payload);
  }

  /** Bearer tokens by tenant, from {@code ENGINE_AUTH_TOKENS}. */
  public static final class Auth {
    private static final Pattern ENTRY = Pattern.compile(
        "([A-Za-z0-9._-]{1,64})=([\\x21-\\x2B\\x2D-\\x7E]{16,256})");
    private static final Auth DISABLED = new Auth(new ArrayList<String>(), new ArrayList<byte[]>());

    private final List<String> tenants;
    private final List<byte[]> digests;

    private Auth(List<String> tenants, List<byte[]> digests) {
      this.tenants = tenants;
      this.digests = digests;
    }

    public static Auth disabled() { return DISABLED; }

    /**
     * Parses {@code tenant=token,tenant2=token2}.  Unset or empty means open.  Anything else that is
     * not exactly that form (an empty entry, a short token, a repeated tenant or token) throws
     * {@link IllegalStateException}: a half-configured engine must not start.
     */
    public static Auth parse(String raw) {
      if (raw == null || raw.isEmpty()) return DISABLED;
      List<String> tenants = new ArrayList<String>();
      List<byte[]> digests = new ArrayList<byte[]>();
      Set<String> seenTokens = new LinkedHashSet<String>();
      for (String entry : raw.split(",", -1)) {
        Matcher matcher = ENTRY.matcher(entry.trim());
        if (!matcher.matches()) {
          throw new IllegalStateException("ENGINE_AUTH_TOKENS must be 'tenant=token,...' with tenant "
              + "[A-Za-z0-9._-]{1,64} and token of 16-256 printable characters without ',' or spaces");
        }
        String tenant = matcher.group(1);
        String token = matcher.group(2);
        if (tenants.contains(tenant) || !seenTokens.add(token)) {
          throw new IllegalStateException("ENGINE_AUTH_TOKENS repeats a tenant or a token");
        }
        tenants.add(tenant);
        digests.add(digest(token));
      }
      return new Auth(tenants, digests);
    }

    public boolean enabled() { return !tenants.isEmpty(); }

    /**
     * The tenant of an {@code Authorization} header, or {@code null} when authentication is required
     * and the header is missing or does not carry a configured token.  When authentication is off every
     * caller is the anonymous tenant {@code ""}.
     */
    public String tenant(String authorization) {
      if (!enabled()) return "";
      if (authorization == null || authorization.length() < 8
          || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)) return null;
      byte[] presented = digest(authorization.substring(7).trim());
      String found = null;
      // Compare against every token so the time does not depend on which one matched.
      for (int index = 0; index < digests.size(); index++) {
        if (MessageDigest.isEqual(presented, digests.get(index))) found = tenants.get(index);
      }
      return found;
    }

    private static byte[] digest(String token) {
      try {
        return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
      } catch (NoSuchAlgorithmException exception) {
        throw new IllegalStateException("SHA-256 is unavailable", exception);
      }
    }
  }

  /** Deployment settings read once at startup. */
  public static final class Settings {
    private final int port;
    private final boolean async;
    private final Auth auth;
    private final EngineJobs.Settings jobs;

    public Settings(int port, boolean async, Auth auth, EngineJobs.Settings jobs) {
      this.port = port;
      this.async = async;
      this.auth = auth;
      this.jobs = jobs;
    }

    /**
     * {@code PORT} (default 8080), {@code ENGINE_JOB_MODE} ({@code sync}, the default, or
     * {@code async}), {@code ENGINE_AUTH_TOKENS} and the {@code ENGINE_JOB_*} limits.  Malformed values
     * throw {@link IllegalStateException}, so the engine does not start.
     */
    public static Settings fromEnvironment(Map<String, String> env) {
      int port = 8080;
      String rawPort = env.get("PORT");
      if (rawPort != null && !rawPort.isEmpty()) {
        try {
          port = Integer.parseInt(rawPort.trim());
        } catch (NumberFormatException exception) {
          port = -1;
        }
        if (port < 1 || port > 65535) throw new IllegalStateException("PORT must be an integer in [1,65535]");
      }
      String mode = env.get("ENGINE_JOB_MODE");
      boolean async;
      if (mode == null || mode.isEmpty() || "sync".equals(mode)) async = false;
      else if ("async".equals(mode)) async = true;
      else throw new IllegalStateException("ENGINE_JOB_MODE must be 'sync' or 'async'");
      Auth auth = Auth.parse(env.get("ENGINE_AUTH_TOKENS"));
      EngineJobs.Settings jobs = async ? EngineJobs.Settings.fromEnvironment(env) : EngineJobs.Settings.defaults();
      return new Settings(port, async, auth, jobs);
    }

    public int port() { return port; }
    public boolean async() { return async; }
    public Auth auth() { return auth; }
    public EngineJobs.Settings jobs() { return jobs; }
  }

  /**
   * Mounts the solving endpoint on {@code server}.
   *
   * <p>Synchronous mode registers {@code syncHandler} exactly as the engine always did (behind the
   * bearer check only if tokens are configured).  Asynchronous mode registers the 202 submit handler,
   * the job endpoints and {@code /openapi.json}.  Returns the job store (to be closed at shutdown), or
   * {@code null} in synchronous mode.</p>
   *
   * @param baseOpenApi the engine's own OpenAPI document, if it has one; {@code null} to generate one
   */
  public static EngineJobs install(HttpServer server, Engine engine, HttpHandler syncHandler,
      Settings settings, String title, byte[] baseOpenApi) {
    if (!settings.async()) {
      server.createContext(SUBMIT_PATH,
          settings.auth().enabled() ? authenticated(syncHandler, settings.auth()) : syncHandler);
      return null;
    }
    EngineJobs jobs = new EngineJobs(settings.jobs());
    server.createContext(SUBMIT_PATH, new SubmitHandler(engine, jobs, settings.auth()));
    server.createContext(JOBS_PATH, new JobHandler(jobs, settings.auth()));
    final byte[] document = EngineContract.json(deploymentOpenApi(title, baseOpenApi))
        .getBytes(StandardCharsets.UTF_8);
    server.createContext(OPENAPI_PATH, new HttpHandler() {
      @Override public void handle(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
          exchange.sendResponseHeaders(405, -1);
          exchange.close();
          return;
        }
        send(exchange, 200, "application/json", document);
      }
    });
    return jobs;
  }

  /** The synchronous handler behind the bearer check. */
  public static HttpHandler authenticated(final HttpHandler delegate, final Auth auth) {
    return new HttpHandler() {
      @Override public void handle(HttpExchange exchange) throws IOException {
        if (auth.tenant(exchange.getRequestHeaders().getFirst("Authorization")) == null) {
          unauthorized(exchange);
          return;
        }
        delegate.handle(exchange);
      }
    };
  }

  /**
   * The OpenAPI document an asynchronous deployment serves: the engine's own document (or a generated
   * one) plus the 202 answer, the job endpoints with DELETE, and the
   * {@code extensions.cancellation} capability.  Cancellation is not part of bim-engine/v1; it is an
   * optional extension and a client must test for the capability before relying on DELETE.
   */
  public static JsonObject deploymentOpenApi(String title, byte[] baseOpenApi) {
    JsonObject document;
    if (baseOpenApi != null) {
      document = new JsonParser().parse(new String(baseOpenApi, StandardCharsets.UTF_8)).getAsJsonObject();
    } else {
      document = new JsonParser().parse("{\"openapi\":\"3.1.0\",\"info\":{\"title\":" + quote(title)
          + ",\"version\":\"1.1.0\"},\"x-bim-protocol\":\"bim-engine/v1\",\"paths\":{"
          + "\"/health\":{\"get\":{\"responses\":{\"200\":{\"description\":\"Engine is ready.\"}}}}},"
          + "\"components\":{\"schemas\":{}}}").getAsJsonObject();
    }
    JsonObject paths = child(document, "paths");
    JsonObject submit = child(child(paths, SUBMIT_PATH), "post");
    if (!submit.has("requestBody")) {
      submit.add("requestBody", new JsonParser().parse("{\"required\":true,\"content\":{"
          + "\"application/json\":{\"schema\":{\"type\":\"object\","
          + "\"description\":\"bim-engine/v1 BindingProblemRequest\"}}}}"));
    }
    JsonObject responses = child(submit, "responses");
    if (!responses.has("200")) {
      responses.add("200", described("Not used in asynchronous mode; the result is read from the job."));
    }
    responses.add("202", content("The request was accepted; poll the job.", "EngineJobAccepted"));
    responses.add("401", problem("A bearer token is required."));
    responses.add("413", problem("The request body exceeds the engine transport limit."));
    responses.add("422", problem("The IR or requested options are not supported by this engine mode."));
    responses.add("500", problem("The engine failed while preparing the request."));
    responses.add("503", problem("The engine is at capacity; retry later."));

    JsonObject job = child(paths, JOBS_PATH + "{id}");
    JsonArray parameters = new JsonArray();
    parameters.add(new JsonParser().parse("{\"in\":\"path\",\"name\":\"id\",\"required\":true,"
        + "\"schema\":{\"type\":\"string\",\"minLength\":1}}"));
    job.add("parameters", parameters);
    JsonObject get = child(job, "get");
    get.addProperty("summary", "Read an asynchronous engine job.");
    JsonObject getResponses = child(get, "responses");
    getResponses.add("200", content("Current engine job state. A cancelled job is reported as failed "
        + "with an error that starts with 'cancelled:'.", "EngineJob"));
    getResponses.add("401", problem("A bearer token is required."));
    getResponses.add("404", problem("The engine job does not exist."));
    JsonObject delete = child(job, "delete");
    delete.addProperty("summary", "Cancel an engine job (optional extension, not in bim-engine/v1).");
    JsonObject deleteResponses = child(delete, "responses");
    deleteResponses.add("200", content("The solver is confirmed stopped, or the job was already final.",
        "JobCancellation"));
    deleteResponses.add("202", content("The solver is still stopping; repeat the request to confirm.",
        "JobCancellation"));
    deleteResponses.add("401", problem("A bearer token is required."));
    deleteResponses.add("404", problem("The engine job does not exist."));

    JsonObject schemas = child(child(document, "components"), "schemas");
    putIfAbsent(schemas, "EngineJobAccepted", "{\"type\":\"object\",\"additionalProperties\":false,"
        + "\"required\":[\"id\",\"status\"],\"properties\":{\"id\":{\"type\":\"string\",\"minLength\":1},"
        + "\"status\":{\"const\":\"queued\"}}}");
    putIfAbsent(schemas, "EngineJob", "{\"type\":\"object\",\"additionalProperties\":false,"
        + "\"required\":[\"id\",\"status\",\"created_at\"],\"properties\":{"
        + "\"id\":{\"type\":\"string\",\"minLength\":1},"
        + "\"status\":{\"type\":\"string\",\"enum\":[\"queued\",\"running\",\"completed\",\"failed\"]},"
        + "\"created_at\":{\"type\":\"integer\",\"minimum\":0},"
        + "\"result\":{\"$ref\":\"#/components/schemas/BindingResult\"},\"error\":{\"type\":\"string\"}}}");
    putIfAbsent(schemas, "JobCancellation", "{\"type\":\"object\",\"additionalProperties\":false,"
        + "\"required\":[\"id\",\"status\"],\"properties\":{\"id\":{\"type\":\"string\",\"minLength\":1},"
        + "\"status\":{\"type\":\"string\",\"enum\":[\"cancelled\",\"completed\",\"failed\",\"cancelling\"]}}}");
    putIfAbsent(schemas, "Problem", "{\"type\":\"object\",\"required\":[\"type\",\"title\",\"status\","
        + "\"detail\"],\"properties\":{\"type\":{\"type\":\"string\"},\"title\":{\"type\":\"string\"},"
        + "\"status\":{\"type\":\"integer\"},\"detail\":{\"type\":\"string\"}}}");

    document.add("extensions", new JsonParser().parse(
        "{\"cancellation\":{\"supported\":true,\"idScope\":\"attempt\"}}"));
    return document;
  }

  // ---------------------------------------------------------------------------------------------
  // Handlers

  private static final class SubmitHandler implements HttpHandler {
    private final Engine engine;
    private final EngineJobs jobs;
    private final Auth auth;

    SubmitHandler(Engine engine, EngineJobs jobs, Auth auth) {
      this.engine = engine;
      this.jobs = jobs;
      this.auth = auth;
    }

    @Override public void handle(HttpExchange exchange) throws IOException {
      if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
        exchange.sendResponseHeaders(405, -1);
        exchange.close();
        return;
      }
      String tenant = auth.tenant(exchange.getRequestHeaders().getFirst("Authorization"));
      if (tenant == null) {
        unauthorized(exchange);
        return;
      }
      try {
        EngineJobs.Work work = engine.prepare(readBody(exchange.getRequestBody()));
        EngineJobs.Snapshot accepted = jobs.submit(tenant, work);
        JsonObject receipt = new JsonObject();
        receipt.addProperty("id", accepted.id());
        receipt.addProperty("status", accepted.state().wire());
        writeJson(exchange, 202, EngineContract.json(receipt));
      } catch (PayloadTooLarge exception) {
        writeProblem(exchange, 413, exception.getMessage());
      } catch (IllegalArgumentException exception) {
        writeProblem(exchange, 422, exception.getMessage());
      } catch (EngineJobs.Rejected exception) {
        exchange.getResponseHeaders().set("Retry-After", "5");
        writeProblem(exchange, 503, exception.getMessage());
      } catch (RuntimeException exception) {
        writeProblem(exchange, 500, "Engine execution failed: " + exception.getMessage());
      }
    }
  }

  private static final class JobHandler implements HttpHandler {
    private final EngineJobs jobs;
    private final Auth auth;

    JobHandler(EngineJobs jobs, Auth auth) {
      this.jobs = jobs;
      this.auth = auth;
    }

    @Override public void handle(HttpExchange exchange) throws IOException {
      String method = exchange.getRequestMethod().toUpperCase(Locale.ROOT);
      String tenant = auth.tenant(exchange.getRequestHeaders().getFirst("Authorization"));
      if (tenant == null) {
        unauthorized(exchange);
        return;
      }
      if (!"GET".equals(method) && !"DELETE".equals(method)) {
        exchange.getResponseHeaders().set("Allow", "GET, DELETE");
        exchange.sendResponseHeaders(405, -1);
        exchange.close();
        return;
      }
      try {
        String path = exchange.getRequestURI().getPath();
        String id = path != null && path.startsWith(JOBS_PATH) ? path.substring(JOBS_PATH.length()) : "";
        if (!JOB_ID.matcher(id).matches()) {
          notFound(exchange);
          return;
        }
        if ("GET".equals(method)) get(exchange, tenant, id);
        else delete(exchange, tenant, id);
      } catch (RuntimeException exception) {
        writeProblem(exchange, 500, "Engine execution failed: " + exception.getMessage());
      }
    }

    private void get(HttpExchange exchange, String tenant, String id) throws IOException {
      EngineJobs.Snapshot job = jobs.get(tenant, id);
      if (job == null) {
        notFound(exchange);
        return;
      }
      writeJson(exchange, 200, jobBody(job));
    }

    private void delete(HttpExchange exchange, String tenant, String id) throws IOException {
      EngineJobs.CancelOutcome outcome = jobs.cancel(tenant, id);
      if (outcome == null) {
        notFound(exchange);
        return;
      }
      JsonObject body = new JsonObject();
      body.addProperty("id", outcome.snapshot().id());
      body.addProperty("status", outcome.stopped() ? outcome.snapshot().state().wire() : "cancelling");
      writeJson(exchange, outcome.stopped() ? 200 : 202, EngineContract.json(body));
    }
  }

  /** The bim-engine/v1 {@code EngineJob} of a snapshot (four states only). */
  static String jobBody(EngineJobs.Snapshot job) {
    String status;
    String tail = "";
    switch (job.state()) {
      case QUEUED:
        status = "queued";
        break;
      case RUNNING:
      case CANCELLING:
        status = "running";
        break;
      case COMPLETED:
        status = "completed";
        tail = ",\"result\":" + job.result();
        break;
      case CANCELLED:
        status = "failed";
        tail = ",\"error\":" + quote("cancelled: " + job.cancelReason());
        break;
      default:
        status = "failed";
        tail = ",\"error\":" + quote(job.error());
        break;
    }
    return "{\"id\":" + quote(job.id()) + ",\"status\":\"" + status + "\",\"created_at\":"
        + job.createdAtSeconds() + tail + "}";
  }

  // ---------------------------------------------------------------------------------------------
  // Plumbing

  private static void unauthorized(HttpExchange exchange) throws IOException {
    exchange.getResponseHeaders().set("WWW-Authenticate", "Bearer");
    writeProblem(exchange, 401, "A valid bearer token is required");
  }

  /** The same answer for an id that never existed, expired, is malformed or belongs to someone else. */
  private static void notFound(HttpExchange exchange) throws IOException {
    writeProblem(exchange, 404, "The engine job does not exist.");
  }

  private static String readBody(InputStream input) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    long total = 0;
    int read;
    while ((read = input.read(buffer)) >= 0) {
      total += read;
      if (total > MAX_BODY_BYTES) throw new PayloadTooLarge("Request body exceeds 64 MiB");
      output.write(buffer, 0, read);
    }
    return new String(output.toByteArray(), StandardCharsets.UTF_8);
  }

  private static void writeProblem(HttpExchange exchange, int status, String detail) throws IOException {
    JsonObject problem = new JsonObject();
    problem.addProperty("type", "https://bim.dev/problems/engine-request");
    problem.addProperty("title", title(status));
    problem.addProperty("status", status);
    problem.addProperty("detail", detail == null ? "Unknown error" : detail);
    send(exchange, status, "application/problem+json",
        EngineContract.json(problem).getBytes(StandardCharsets.UTF_8));
  }

  private static String title(int status) {
    switch (status) {
      case 401: return "Authentication required";
      case 404: return "Engine job not found";
      case 422: return "Invalid BIM engine request";
      case 503: return "BIM engine busy";
      default: return "BIM engine error";
    }
  }

  private static void writeJson(HttpExchange exchange, int status, String payload) throws IOException {
    send(exchange, status, "application/json", payload.getBytes(StandardCharsets.UTF_8));
  }

  private static void send(HttpExchange exchange, int status, String contentType, byte[] body) throws IOException {
    exchange.getResponseHeaders().set("Content-Type", contentType);
    exchange.sendResponseHeaders(status, body.length);
    OutputStream output = exchange.getResponseBody();
    output.write(body);
    output.close();
    exchange.close();
  }

  private static String quote(String value) {
    return EngineContract.json(new com.google.gson.JsonPrimitive(value == null ? "" : value));
  }

  private static JsonObject child(JsonObject owner, String name) {
    if (!owner.has(name) || !owner.get(name).isJsonObject()) owner.add(name, new JsonObject());
    return owner.getAsJsonObject(name);
  }

  private static JsonObject described(String description) {
    JsonObject value = new JsonObject();
    value.addProperty("description", description);
    return value;
  }

  private static JsonObject content(String description, String schema) {
    return new JsonParser().parse("{\"description\":" + quote(description) + ",\"content\":{"
        + "\"application/json\":{\"schema\":{\"$ref\":\"#/components/schemas/" + schema + "\"}}}}")
        .getAsJsonObject();
  }

  private static JsonObject problem(String description) {
    return new JsonParser().parse("{\"description\":" + quote(description) + ",\"content\":{"
        + "\"application/problem+json\":{\"schema\":{\"$ref\":\"#/components/schemas/Problem\"}}}}")
        .getAsJsonObject();
  }

  private static void putIfAbsent(JsonObject schemas, String name, String schema) {
    if (!schemas.has(name)) schemas.add(name, new JsonParser().parse(schema));
  }

  private static final class PayloadTooLarge extends RuntimeException {
    private static final long serialVersionUID = 1L;
    PayloadTooLarge(String message) { super(message); }
  }
}
