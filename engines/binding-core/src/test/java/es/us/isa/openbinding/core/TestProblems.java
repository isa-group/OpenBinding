package es.us.isa.openbinding.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.*;

public final class TestProblems {
  private TestProblems() {}

  public static JsonObject twoCandidates() {
    String json = "{"
        + "\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblem\",\"metadata\":{\"name\":\"two\"},"
        + "\"spec\":{"
        + "\"profile\":{\"namespace\":\"bim.builtin\",\"id\":\"qos-binding/v1\",\"version\":\"1.0.0\","
        + "\"output\":{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblem\",\"schemaDigest\":\""
        + digest("ir-schema") + "\"},\"deterministic\":true,\"digest\":\"" + digest("profile") + "\","
        + "\"adapter\":{\"id\":\"qos-binding-profile\",\"version\":\"1.0.0\",\"digest\":\""
        + digest("profile-adapter") + "\"}},"
        + "\"dialects\":[{\"namespace\":\"bim.builtin\",\"id\":\"qos-binding/v1\",\"version\":\"1.0.0\","
        + "\"digest\":\"" + digest("dialect") + "\",\"irFeatures\":[],"
        + "\"adapter\":{\"id\":\"bim-core\",\"version\":\"1.0.0\",\"digest\":\""
        + digest("dialect-adapter") + "\"}}],"
        + "\"instance\":{\"digest\":\"" + digest("instance") + "\",\"resources\":{"
        + resource("app", "application", "Application", "application.json") + ","
        + resource("catalog-a", "candidates", "CandidateCatalog", "catalog-a.json") + ","
        + resource("catalog-b", "candidates", "CandidateCatalog", "catalog-b.json") + ","
        + resource("optimization", "optimization", "Optimization", "optimization.json") + "}},"
        + "\"application\":{\"resource\":\"app\","
        + "\"tasks\":{\"t\":{\"kind\":\"service\",\"requires\":{\"type\":\"compute\"}}},"
        + "\"metrics\":{" + metric("cost", "selectedCandidate") + "," + metric("latency", "invocation") + "},"
        + "\"requiredMetrics\":[\"cost\",\"latency\"],\"taskRequiredMetrics\":{},"
        + "\"workflow\":{\"kind\":\"task\",\"task\":{\"resource\":\"app\",\"id\":\"t\"}}},"
        + "\"candidates\":{"
        + "\"catalog-a\":" + catalog("catalog-a", "service", "provider-a", 1, 10, "eu") + ","
        + "\"catalog-b\":" + catalog("catalog-b", "service", "provider-b", 9, 1, "us") + "},"
        + "\"eligibility\":{\"t\":[{\"resource\":\"catalog-a\",\"id\":\"service\"},{\"resource\":\"catalog-b\",\"id\":\"service\"}]},"
        + "\"routing\":[],\"constraints\":[],\"placement\":[],"
        + "\"optimization\":{\"resource\":\"optimization\",\"criteria\":[{\"id\":\"cost\","
        + "\"feature\":{\"resource\":\"app\",\"id\":\"cost\"},\"direction\":\"minimize\"}],"
        + "\"penalties\":[]},"
        + "\"extensions\":{},\"sourceMap\":{}}}";
    return new JsonParser().parse(json).getAsJsonObject();
  }

  public static JsonObject twoCandidatesWithFeatures() {
    String json = "{"
        + "\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblem\",\"metadata\":{\"name\":\"two\"},"
        + "\"spec\":{"
        + "\"profile\":{\"namespace\":\"bim.builtin\",\"id\":\"qos-binding/v1\",\"version\":\"1.0.0\","
        + "\"output\":{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblem\",\"schemaDigest\":\""
        + digest("ir-schema") + "\"},\"deterministic\":true,\"digest\":\"" + digest("profile") + "\","
        + "\"adapter\":{\"id\":\"qos-binding-profile\",\"version\":\"1.0.0\",\"digest\":\""
        + digest("profile-adapter") + "\"}},"
        + "\"dialects\":[{\"namespace\":\"bim.builtin\",\"id\":\"qos-binding/v1\",\"version\":\"1.0.0\","
        + "\"digest\":\"" + digest("dialect") + "\",\"irFeatures\":[],"
        + "\"adapter\":{\"id\":\"bim-core\",\"version\":\"1.0.0\",\"digest\":\""
        + digest("dialect-adapter") + "\"}}],"
        + "\"instance\":{\"digest\":\"" + digest("instance") + "\",\"resources\":{"
        + resource("app", "application", "Application", "application.json") + ","
        + resource("catalog-a", "candidates", "CandidateCatalog", "catalog-a.json") + ","
        + resource("catalog-b", "candidates", "CandidateCatalog", "catalog-b.json") + ","
        + resource("optimization", "optimization", "Optimization", "optimization.json") + "}},"
        + "\"application\":{\"resource\":\"app\","
        + "\"tasks\":{\"t\":{\"kind\":\"service\",\"requires\":{\"type\":\"compute\"}}},"
        + "\"features\":{" + metric("cost", "selectedCandidate") + "," + metric("latency", "invocation") + "},"
        + "\"requiredFeatures\":[\"cost\",\"latency\"],\"taskRequiredFeatures\":{},"
        + "\"workflow\":{\"kind\":\"task\",\"task\":{\"resource\":\"app\",\"id\":\"t\"}}},"
        + "\"candidates\":{"
        + "\"catalog-a\":" + catalogWithFeatures("catalog-a", "service", "provider-a", 1, 10, "eu") + ","
        + "\"catalog-b\":" + catalogWithFeatures("catalog-b", "service", "provider-b", 9, 1, "us") + "},"
        + "\"eligibility\":{\"t\":[{\"resource\":\"catalog-a\",\"id\":\"service\"},{\"resource\":\"catalog-b\",\"id\":\"service\"}]},"
        + "\"routing\":[],\"constraints\":[],\"placement\":[],"
        + "\"optimization\":{\"resource\":\"optimization\",\"criteria\":[{\"id\":\"cost\","
        + "\"feature\":{\"resource\":\"app\",\"id\":\"cost\"},\"direction\":\"minimize\"}],"
        + "\"penalties\":[]},"
        + "\"extensions\":{},\"sourceMap\":{}}}";
    return new JsonParser().parse(json).getAsJsonObject();
  }

  public static String envelope(JsonObject problem, String options) {
    return envelope(problem, "weighted", options);
  }

  public static String envelope(JsonObject problem, String scalarization, String options) {
    return "{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblemRequest\","
        + "\"protocol\":\"bim-engine/v1\",\"problem\":" + problem
        + ",\"optimization\":{\"type\":\"SINGLE\",\"scalarization\":\"" + scalarization
        + "\",\"weights\":[{\"criteria\":\"cost\",\"value\":1.0}]}"
        + ",\"options\":" + options + "}";
  }

  /**
   * A request whose execution optimization is spelled out.  The IR itself only lists
   * {@code criteria}; the objective type, scalarization and weights are per-execution input.
   */
  public static String request(JsonObject problem, String type, String scalarization,
      String weights, String options) {
    return "{\"apiVersion\":\"bim/v1\",\"kind\":\"BindingProblemRequest\","
        + "\"protocol\":\"bim-engine/v1\",\"problem\":" + problem
        + ",\"optimization\":{\"type\":\"" + type + "\",\"scalarization\":\"" + scalarization
        + "\",\"weights\":" + weights + "},\"options\":" + options + "}";
  }

  /** A Pareto request ({@code pareto-front}, no weights) of the given objective type. */
  public static String paretoRequest(JsonObject problem, String type, String options) {
    return request(problem, type, "pareto-front", "[]", options);
  }

  /**
   * Pads the IR criteria to {@code count} by repeating the first criterion under the ids
   * {@code cost-2}, {@code cost-3}, ...; the evaluated feature stays the same one.
   */
  public static JsonObject withCriteria(JsonObject problem, int count) {
    com.google.gson.JsonArray criteria = problem.getAsJsonObject("spec")
        .getAsJsonObject("optimization").getAsJsonArray("criteria");
    while (criteria.size() < count) {
      JsonObject copy = criteria.get(0).getAsJsonObject().deepCopy();
      copy.addProperty("id", "cost-" + (criteria.size() + 1));
      criteria.add(copy);
    }
    return problem;
  }

  public static Map<String, BindingProblem.Ref> decision(String catalog) {
    Map<String, BindingProblem.Ref> binding = new LinkedHashMap<String, BindingProblem.Ref>();
    binding.put("t", new BindingProblem.Ref(catalog, "service"));
    return binding;
  }

  /**
   * {@code tasks} service tasks in sequence, each bound to either catalog.  Every evaluation walks the
   * whole sequence, so a search with a large budget over this problem runs for minutes: a workload
   * that only ends early when it is cancelled.
   */
  public static JsonObject heavy(int tasks) {
    JsonObject document = twoCandidates();
    JsonObject spec = document.getAsJsonObject("spec");
    JsonObject application = spec.getAsJsonObject("application");
    JsonObject template = application.getAsJsonObject("tasks").getAsJsonObject("t");
    JsonArray both = spec.getAsJsonObject("eligibility").getAsJsonArray("t");
    JsonObject taskMap = new JsonObject();
    JsonObject eligibility = new JsonObject();
    JsonArray steps = new JsonArray();
    for (int index = 0; index < tasks; index++) {
      String name = "t" + index;
      taskMap.add(name, template.deepCopy());
      eligibility.add(name, both.deepCopy());
      JsonObject step = new JsonObject();
      step.addProperty("kind", "task");
      JsonObject ref = new JsonObject();
      ref.addProperty("resource", "app");
      ref.addProperty("id", name);
      step.add("task", ref);
      steps.add(step);
    }
    JsonObject sequence = new JsonObject();
    sequence.addProperty("kind", "sequence");
    sequence.add("steps", steps);
    application.add("tasks", taskMap);
    application.add("workflow", sequence);
    spec.add("eligibility", eligibility);
    return document;
  }

  // -------------------------------------------------------------------------------------------
  // Asynchronous-mode test bench: a real HttpServer with EngineHttp installed, real HTTP calls.

  /** One HTTP answer. */
  public static final class Reply {
    public final int status;
    public final String body;
    private final Map<String, List<String>> headers;

    Reply(int status, String body, Map<String, List<String>> headers) {
      this.status = status;
      this.body = body;
      this.headers = headers;
    }

    public JsonObject json() { return new JsonParser().parse(body).getAsJsonObject(); }

    public String header(String name) {
      for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
        if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) return entry.getValue().get(0);
      }
      return null;
    }
  }

  public static Reply http(String method, String url, String token, String body) throws IOException {
    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
    connection.setRequestMethod(method);
    connection.setConnectTimeout(10000);
    connection.setReadTimeout(60000);
    if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
    if (body != null) {
      connection.setDoOutput(true);
      connection.setRequestProperty("Content-Type", "application/json");
      OutputStream output = connection.getOutputStream();
      output.write(body.getBytes(StandardCharsets.UTF_8));
      output.close();
    }
    int status = connection.getResponseCode();
    InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
    String text = "";
    if (input != null) {
      ByteArrayOutputStream buffer = new ByteArrayOutputStream();
      byte[] chunk = new byte[8192];
      int read;
      while ((read = input.read(chunk)) >= 0) buffer.write(chunk, 0, read);
      input.close();
      text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }
    return new Reply(status, text, connection.getHeaderFields());
  }

  /** An engine behind a real HTTP server on an ephemeral loopback port. */
  public static final class Rig implements AutoCloseable {
    public static final String JOBS = EngineHttp.JOBS_PATH;
    private final HttpServer server;
    private final java.util.concurrent.ExecutorService handlers;
    /** The job store, or {@code null} for a synchronous engine. */
    public final EngineJobs jobs;
    public final String base;

    public Rig(EngineHttp.Engine engine, HttpHandler sync, boolean async, String tokens,
        EngineJobs.Settings limits) throws IOException {
      server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
      EngineHttp.Settings settings = new EngineHttp.Settings(1, async, EngineHttp.Auth.parse(tokens), limits);
      jobs = EngineHttp.install(server, engine, sync, settings, "Test engine", null);
      handlers = Executors.newCachedThreadPool(new java.util.concurrent.ThreadFactory() {
        @Override public Thread newThread(Runnable runnable) {
          Thread thread = new Thread(runnable, "test-http");
          thread.setDaemon(true);
          return thread;
        }
      });
      server.setExecutor(handlers);
      server.start();
      base = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public Reply post(String payload, String token) throws IOException {
      return http("POST", base + EngineHttp.SUBMIT_PATH, token, payload);
    }
    public Reply get(String id, String token) throws IOException {
      return http("GET", base + JOBS + id, token, null);
    }
    public Reply delete(String id, String token) throws IOException {
      return http("DELETE", base + JOBS + id, token, null);
    }

    /** Submits and checks the 202 receipt is exactly {@code EngineJobAccepted}; returns the id. */
    public String submit(String payload, String token) throws IOException {
      Reply reply = post(payload, token);
      assertEquals(202, reply.status, reply.body);
      JsonObject receipt = reply.json();
      assertEquals(new java.util.HashSet<String>(Arrays.asList("id", "status")), receipt.keySet());
      assertEquals("queued", receipt.get("status").getAsString());
      assertTrue(receipt.get("id").getAsString().matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"));
      return receipt.get("id").getAsString();
    }

    /** Polls the job until its (contract) status is one of {@code states}; fails after the timeout. */
    public JsonObject await(String id, String token, long timeoutMs, String... states) throws Exception {
      long deadline = System.nanoTime() + timeoutMs * 1000000L;
      String last = null;
      List<String> wanted = Arrays.asList(states);
      while (System.nanoTime() < deadline) {
        Reply reply = get(id, token);
        last = reply.status + " " + reply.body;
        if (reply.status == 200 && wanted.contains(reply.json().get("status").getAsString())) return reply.json();
        Thread.sleep(25);
      }
      fail("job " + id + " never reached " + wanted + "; last answer " + last);
      return null;
    }

    @Override public void close() {
      server.stop(0);
      if (jobs != null) jobs.close();
      handlers.shutdownNow();
    }
  }

  public static boolean awaitTrue(long timeoutMs, BooleanSupplier condition) throws InterruptedException {
    long deadline = System.nanoTime() + timeoutMs * 1000000L;
    while (System.nanoTime() < deadline) {
      if (condition.getAsBoolean()) return true;
      Thread.sleep(10);
    }
    return condition.getAsBoolean();
  }

  /** Live threads with a stack frame in a class whose name contains {@code fragment}. */
  public static List<Thread> threadsRunning(String fragment) {
    List<Thread> found = new ArrayList<Thread>();
    for (Map.Entry<Thread, StackTraceElement[]> entry : Thread.getAllStackTraces().entrySet()) {
      for (StackTraceElement frame : entry.getValue()) {
        if (frame.getClassName().contains(fragment)) {
          found.add(entry.getKey());
          break;
        }
      }
    }
    return found;
  }

  /** CPU time of {@code thread} so far, or {@code -1} when it is gone or the JVM cannot measure it. */
  public static long cpuNanos(Thread thread) {
    ThreadMXBean bean = ManagementFactory.getThreadMXBean();
    return bean.isThreadCpuTimeSupported() ? bean.getThreadCpuTime(thread.getId()) : -1L;
  }

  // -------------------------------------------------------------------------------------------
  // Scenarios shared by the per-engine *CancelTest classes.  Each engine brings its own slow
  // payload (a budget it cannot finish) and the name of its solver class, so the same behaviour is
  // checked against four different solvers.

  /** Limits for a bench with a single slot and room for a few queued jobs. */
  public static EngineJobs.Settings oneSlot() {
    return new EngineJobs.Settings(1, 4, 64, 60000L, 5000L);
  }

  public static void stopsSolverAndCpu(Rig rig, String slow, String frame) throws Exception {
    String id = rig.submit(slow, null);
    rig.await(id, null, 30000, "running");
    assertTrue(awaitTrue(15000, () -> !threadsRunning(frame).isEmpty()), "the solver runs in " + frame);
    List<Thread> solvers = threadsRunning(frame);
    assertEquals(1, solvers.size());
    Thread solver = solvers.get(0);

    long checkpoints = Cancellation.totalCheckpoints();
    long cpu = cpuNanos(solver);
    Thread.sleep(300);
    assertTrue(Cancellation.totalCheckpoints() > checkpoints, "a running solver passes checkpoints");
    // Lenient on purpose: the image builds run these tests under a throttled cgroup.
    if (cpu >= 0) assertTrue(cpuNanos(solver) - cpu > 5000000L, "a running solver burns CPU");

    Reply deleted = rig.delete(id, null);
    assertEquals(200, deleted.status, deleted.body);
    JsonObject receipt = deleted.json();
    assertEquals(new java.util.HashSet<String>(Arrays.asList("id", "status")), receipt.keySet());
    assertEquals(id, receipt.get("id").getAsString());
    assertEquals("cancelled", receipt.get("status").getAsString());
    assertTrue(threadsRunning(frame).isEmpty(), "cancelled means no thread is inside the solver");

    long stopped = Cancellation.totalCheckpoints();
    long cpuStopped = cpuNanos(solver);
    Thread.sleep(400);
    assertEquals(stopped, Cancellation.totalCheckpoints(), "no checkpoint is passed after cancel");
    if (cpuStopped >= 0) {
      assertTrue(cpuNanos(solver) - cpuStopped < 30000000L, "the solver thread stopped burning CPU");
    }
    assertEquals(0, rig.jobs.active());

    JsonObject job = rig.get(id, null).json();
    assertEquals("failed", job.get("status").getAsString());
    assertTrue(job.get("error").getAsString().startsWith("cancelled:"), job.toString());
    assertFalse(job.has("result"));
    assertTrue(job.get("created_at").getAsLong() > 0);
    // Idempotent: the same answer again, and the job stays cancelled.
    Reply again = rig.delete(id, null);
    assertEquals(200, again.status);
    assertEquals("cancelled", again.json().get("status").getAsString());
    assertEquals(job.toString(), rig.get(id, null).json().toString());
  }

  /** Needs a bench with one slot: a queued job leaves without running, a freed slot starts the next. */
  public static void queuedCancelAndSlotRelease(Rig rig, String slow, String quick, String frame) throws Exception {
    String first = rig.submit(slow, null);
    rig.await(first, null, 30000, "running");
    String queuedSlow = rig.submit(slow, null);
    String waiting = rig.submit(quick, null);
    assertEquals("queued", rig.get(queuedSlow, null).json().get("status").getAsString());
    assertEquals("queued", rig.get(waiting, null).json().get("status").getAsString());

    Reply gone = rig.delete(queuedSlow, null);
    assertEquals(200, gone.status, gone.body);
    assertEquals("cancelled", gone.json().get("status").getAsString());
    assertTrue(rig.get(queuedSlow, null).json().get("error").getAsString().startsWith("cancelled:"));
    assertEquals(1, threadsRunning(frame).size(), "only the first job's solver is running");
    Thread.sleep(300);
    assertEquals("queued", rig.get(waiting, null).json().get("status").getAsString(),
        "the slot is taken, so the next job waits");

    Reply stopped = rig.delete(first, null);
    assertEquals(200, stopped.status, stopped.body);
    JsonObject done = rig.await(waiting, null, 60000, "completed");
    assertTrue(done.getAsJsonObject("result").has("solutions"));
    assertTrue(done.getAsJsonObject("result").has("termination"));
    assertEquals(0, rig.jobs.active());
    assertEquals("failed", rig.get(first, null).json().get("status").getAsString());
  }

  /** Needs a bench with two tenants, {@code alpha} and {@code beta}. */
  public static void tenantIsolation(Rig rig, String slow, String frame, String alpha, String beta)
      throws Exception {
    Reply anonymous = rig.post(slow, null);
    assertEquals(401, anonymous.status);
    assertEquals("Bearer", anonymous.header("WWW-Authenticate"));
    assertEquals(401, rig.post(slow, "not-a-configured-token-at-all").status);
    assertEquals(0, rig.jobs.retained(), "an unauthenticated request creates nothing");

    String id = rig.submit(slow, alpha);
    rig.await(id, alpha, 30000, "running");
    assertEquals(401, rig.get(id, null).status);
    assertEquals(401, rig.delete(id, null).status);
    assertEquals(401, rig.get(id, "not-a-configured-token-at-all").status);

    String unknownId = java.util.UUID.randomUUID().toString();
    Reply foreignGet = rig.get(id, beta);
    Reply foreignDelete = rig.delete(id, beta);
    Reply unknownGet = rig.get(unknownId, beta);
    Reply unknownDelete = rig.delete(unknownId, beta);
    assertEquals(404, foreignGet.status);
    assertEquals(404, foreignDelete.status);
    assertEquals(404, unknownGet.status);
    assertEquals(404, unknownDelete.status);
    assertEquals(unknownGet.body, foreignGet.body, "a foreign id looks exactly like an unknown one");
    assertEquals(unknownDelete.body, foreignDelete.body);
    assertEquals(unknownGet.header("Content-Type"), foreignGet.header("Content-Type"));
    assertEquals(404, rig.get("../" + id, alpha).status);

    Thread.sleep(200);
    assertEquals("running", rig.get(id, alpha).json().get("status").getAsString(),
        "another tenant's DELETE did not touch the job");
    assertFalse(threadsRunning(frame).isEmpty());

    Reply mine = rig.delete(id, alpha);
    assertEquals(200, mine.status, mine.body);
    assertEquals("cancelled", mine.json().get("status").getAsString());
    assertEquals(404, rig.get(id, beta).status);
  }

  /** DELETE after the end, repeated DELETE, and DELETE racing the end: one final state, never two. */
  public static void deleteVersusFinish(Rig rig, String quick) throws Exception {
    String id = rig.submit(quick, null);
    JsonObject done = rig.await(id, null, 60000, "completed");
    Reply late = rig.delete(id, null);
    assertEquals(200, late.status);
    assertEquals("completed", late.json().get("status").getAsString(), "a finished job is not cancelled");
    assertEquals(done.toString(), rig.get(id, null).json().toString(), "DELETE left a finished job alone");

    for (int attempt = 0; attempt < 25; attempt++) {
      String raced = rig.submit(quick, null);
      Thread.sleep((attempt % 5) * 3);
      Reply first = rig.delete(raced, null);
      assertEquals(200, first.status, first.body);
      String outcome = first.json().get("status").getAsString();
      assertTrue(outcome.equals("cancelled") || outcome.equals("completed"), outcome);
      JsonObject seen = rig.get(raced, null).json();
      if (outcome.equals("completed")) {
        assertEquals("completed", seen.get("status").getAsString());
        assertTrue(seen.has("result"));
      } else {
        assertEquals("failed", seen.get("status").getAsString());
        assertTrue(seen.get("error").getAsString().startsWith("cancelled:"));
        assertFalse(seen.has("result"));
      }
      Reply second = rig.delete(raced, null);
      assertEquals(first.body, second.body, "DELETE is idempotent");
      Thread.sleep(20);
      assertEquals(seen.toString(), rig.get(raced, null).json().toString(),
          "a terminal job never changes, whatever the solver does afterwards");
    }
    assertEquals(0, rig.jobs.active());
  }

  /** A request the engine refuses is a 422 and leaves no job behind. */
  public static void invalidRequestIsRefusedBeforeAnyJobExists(Rig rig, String invalid) throws Exception {
    Reply reply = rig.post(invalid, null);
    assertEquals(422, reply.status, reply.body);
    assertEquals("application/problem+json", reply.header("Content-Type"));
    assertEquals(422, reply.json().get("status").getAsInt());
    assertEquals(0, rig.jobs.retained());
    assertEquals(422, rig.post("not json", null).status);
    assertEquals(0, rig.jobs.retained());
  }

  /** The default mode: 200 with the result, and no job endpoints at all. */
  public static void synchronousEngineHasNoJobs(Rig rig, String quick) throws Exception {
    assertNull(rig.jobs);
    Reply reply = rig.post(quick, null);
    assertEquals(200, reply.status, reply.body);
    JsonObject result = reply.json();
    assertTrue(result.has("termination"));
    assertFalse(result.has("id"));
    for (String method : new String[] {"GET", "DELETE", "POST"}) {
      int status = http(method, rig.base + Rig.JOBS + "00000000-0000-0000-0000-000000000000", null,
          "POST".equals(method) ? "{}" : null).status;
      assertTrue(status == 404 || status == 405, method + " answered " + status);
    }
    int openapi = http("GET", rig.base + EngineHttp.OPENAPI_PATH, null, null).status;
    assertTrue(openapi == 404 || openapi == 200, "openapi answered " + openapi);
  }

  /** The same seeded request gives the same result through the synchronous POST and through a job. */
  public static void sameResultSyncAndAsync(EngineHttp.Engine engine, HttpHandler sync, String quick) throws Exception {
    try (Rig direct = new Rig(engine, sync, false, null, oneSlot());
         Rig queued = new Rig(engine, sync, true, null, oneSlot())) {
      Reply reply = direct.post(quick, null);
      assertEquals(200, reply.status, reply.body);
      String id = queued.submit(quick, null);
      JsonObject viaJob = queued.await(id, null, 60000, "completed").getAsJsonObject("result");
      assertEquals(stripTiming(reply.json()), stripTiming(viaJob));
      assertTrue(viaJob.getAsJsonArray("solutions").size() > 0, "the quick request has a solution");
    }
  }

  /** Job ids live in memory: a restarted engine does not know them, and says so with 404. */
  public static void restartLosesIds(EngineHttp.Engine engine, HttpHandler sync, String quick) throws Exception {
    String id;
    try (Rig before = new Rig(engine, sync, true, null, oneSlot())) {
      id = before.submit(quick, null);
      before.await(id, null, 60000, "completed");
      assertEquals(200, before.get(id, null).status);
    }
    try (Rig after = new Rig(engine, sync, true, null, oneSlot())) {
      assertEquals(404, after.get(id, null).status);
      assertEquals(404, after.delete(id, null).status);
    }
  }

  private static com.google.gson.JsonElement stripTiming(com.google.gson.JsonElement value) {
    if (value.isJsonObject()) {
      JsonObject copy = new JsonObject();
      for (Map.Entry<String, com.google.gson.JsonElement> entry : value.getAsJsonObject().entrySet()) {
        if (!entry.getKey().equals("elapsed_ms")) copy.add(entry.getKey(), stripTiming(entry.getValue()));
      }
      return copy;
    }
    if (value.isJsonArray()) {
      JsonArray copy = new JsonArray();
      for (com.google.gson.JsonElement item : value.getAsJsonArray()) copy.add(stripTiming(item));
      return copy;
    }
    return value;
  }

  private static String metric(String id, String scope) {
    return "\"" + id + "\":{\"type\":\"number\",\"unit\":\"1\","
        + "\"domain\":{\"kind\":\"real\"},\"direction\":\"minimize\","
        + "\"scope\":\"" + scope + "\",\"neutral\":0,"
        + "\"aggregation\":{\"sequence\":\"sum\",\"parallel\":\"sum\","
        + "\"exclusive\":\"weightedSum\",\"repeat\":\"scale\",\"selection\":\"sum\"}}";
  }

  private static String candidate(String catalog, String id, String provider,
      double cost, double latency, String region) {
    return "{\"ref\":{\"resource\":\"" + catalog + "\",\"id\":\"" + id + "\"},"
        + "\"provider\":{\"resource\":\"" + catalog + "\",\"id\":\"" + provider + "\"},"
        + "\"provides\":[{\"type\":\"compute\",\"properties\":{}}],"
        + "\"properties\":{\"region\":\"" + region + "\"},"
        + "\"metrics\":{\"price\":" + cost + ",\"response\":" + latency + "}}";
  }

  private static String candidateWithFeatures(String catalog, String id, String provider,
      double cost, double latency, String region) {
    return "{\"ref\":{\"resource\":\"" + catalog + "\",\"id\":\"" + id + "\"},"
        + "\"provider\":{\"resource\":\"" + catalog + "\",\"id\":\"" + provider + "\"},"
        + "\"provides\":[{\"type\":\"compute\",\"properties\":{}}],"
        + "\"properties\":{\"region\":\"" + region + "\"},"
        + "\"features\":{\"price\":" + cost + ",\"response\":" + latency + "}}";
  }

  private static String catalog(String catalog, String candidate, String provider,
      double cost, double latency, String region) {
    return "{\"providers\":{\"" + provider + "\":{\"properties\":{}}},"
        + "\"metricBindings\":{\"price\":{\"resource\":\"app\",\"id\":\"cost\"},"
        + "\"response\":{\"resource\":\"app\",\"id\":\"latency\"}},"
        + "\"candidates\":{\"" + candidate + "\":"
        + candidate(catalog, candidate, provider, cost, latency, region) + "}}";
  }

  private static String catalogWithFeatures(String catalog, String candidate, String provider,
      double cost, double latency, String region) {
    return "{\"providers\":{\"" + provider + "\":{\"properties\":{}}},"
        + "\"featureBindings\":{\"price\":{\"resource\":\"app\",\"id\":\"cost\"},"
        + "\"response\":{\"resource\":\"app\",\"id\":\"latency\"}},"
        + "\"candidates\":{\"" + candidate + "\":"
        + candidateWithFeatures(catalog, candidate, provider, cost, latency, region) + "}}";
  }

  private static String resource(String id, String role, String kind, String path) {
    return "\"" + id + "\":{\"role\":\"" + role + "\",\"kind\":\"" + kind
        + "\",\"apiVersion\":\"qos-binding/v1\",\"path\":\"" + path
        + "\",\"digest\":\"" + digest(id) + "\"}";
  }

  private static String digest(String seed) {
    String hex = Integer.toHexString(seed.hashCode()).replace("-", "0");
    StringBuilder result = new StringBuilder("sha256-");
    while (result.length() < 71) result.append(hex);
    return result.substring(0, 71);
  }
}
