package es.us.isa.openbinding.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import es.us.isa.openbinding.core.TestProblems.Reply;
import es.us.isa.openbinding.core.TestProblems.Rig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.concurrent.CountDownLatch;

import static org.junit.jupiter.api.Assertions.*;

/** The HTTP layer with fake solvers; the real solvers are covered by each engine's *CancelTest. */
@Timeout(120)
class EngineHttpTest {
  private static final String RESULT = "{\"termination\":\"UNKNOWN\",\"solutions\":[]}";
  private static final String ALPHA = "alpha-token-0123456789";
  private static final String BETA = "beta-token-0123456789x";
  private static final String TOKENS = "alpha=" + ALPHA + ",beta=" + BETA;
  private static final String SPIN = "EngineHttpTest$Spin";

  /** Cooperative and endless: only a cancel ends it. */
  static final class Spin implements EngineJobs.Work {
    @Override public String run() {
      while (true) Cancellation.checkpoint();
    }
  }

  /** Ignores cancellation until released. */
  static final class Gate implements EngineJobs.Work {
    final CountDownLatch started = new CountDownLatch(1);
    final CountDownLatch release = new CountDownLatch(1);
    @Override public String run() {
      started.countDown();
      while (true) {
        try {
          release.await();
          return RESULT;
        } catch (InterruptedException ignored) {
          // keeps waiting: this solver does not honour interruption
        }
      }
    }
  }

  private static final class FakeEngine implements EngineHttp.Engine, HttpHandler {
    final Gate gate = new Gate();

    @Override public EngineJobs.Work prepare(String payload) {
      if ("spin".equals(payload)) return new Spin();
      if ("gate".equals(payload)) return gate;
      if ("quick".equals(payload)) return new EngineJobs.Work() {
        @Override public String run() { return RESULT; }
      };
      if ("fail".equals(payload)) return new EngineJobs.Work() {
        @Override public String run() { throw new IllegalArgumentException("solver said \"no\"\n"); }
      };
      throw new IllegalArgumentException("unsupported payload");
    }

    /** The synchronous handler: answers 200 with a result whatever the body. */
    @Override public void handle(HttpExchange exchange) throws IOException {
      byte[] body = RESULT.getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    }
  }

  private static Rig rig(FakeEngine engine, boolean async, String tokens, EngineJobs.Settings limits) throws IOException {
    return new Rig(engine, engine, async, tokens, limits);
  }

  private static java.util.Set<String> keys(String... names) {
    return new HashSet<String>(Arrays.asList(names));
  }

  @Test void getReturnsExactlyTheEngineJobShapesOfTheContract() throws Exception {
    FakeEngine engine = new FakeEngine();
    try (Rig rig = rig(engine, true, null, TestProblems.oneSlot())) {
      String quick = rig.submit("quick", null);
      JsonObject done = rig.await(quick, null, 20000, "completed");
      assertEquals(keys("id", "status", "created_at", "result"), done.keySet());
      assertEquals(quick, done.get("id").getAsString());
      assertTrue(done.get("created_at").getAsJsonPrimitive().isNumber());
      assertEquals(new JsonParser().parse(RESULT), done.get("result"));

      String failing = rig.submit("fail", null);
      JsonObject failed = rig.await(failing, null, 20000, "failed");
      assertEquals(keys("id", "status", "created_at", "error"), failed.keySet());
      assertEquals("solver said \"no\"\n", failed.get("error").getAsString());

      String spinning = rig.submit("spin", null);
      JsonObject running = rig.await(spinning, null, 20000, "running");
      assertEquals(keys("id", "status", "created_at"), running.keySet());
      String waiting = rig.submit("quick", null);
      JsonObject queued = rig.get(waiting, null).json();
      assertEquals("queued", queued.get("status").getAsString());
      assertEquals(keys("id", "status", "created_at"), queued.keySet());
      assertEquals(200, rig.delete(spinning, null).status);
      rig.await(waiting, null, 20000, "completed");
    }
  }

  @Test void deleteAnswersCancellingWhileTheSolverLivesAndCancelledOnceItIsGone() throws Exception {
    FakeEngine engine = new FakeEngine();
    EngineJobs.Settings impatient = new EngineJobs.Settings(1, 1, 16, 60000L, 100L);
    try (Rig rig = rig(engine, true, null, impatient)) {
      String id = rig.submit("gate", null);
      assertTrue(engine.gate.started.await(20, java.util.concurrent.TimeUnit.SECONDS));

      Reply pending = rig.delete(id, null);
      assertEquals(202, pending.status, pending.body);
      assertEquals(keys("id", "status"), pending.json().keySet());
      assertEquals("cancelling", pending.json().get("status").getAsString());
      JsonObject shown = rig.get(id, null).json();
      assertEquals("running", shown.get("status").getAsString(), "cancelling is running in the 4-state contract");
      assertEquals(keys("id", "status", "created_at"), shown.keySet());
      assertEquals(202, rig.delete(id, null).status, "still alive, still not cancelled");

      engine.gate.release.countDown();
      JsonObject failed = rig.await(id, null, 20000, "failed", "completed");
      assertEquals("failed", failed.get("status").getAsString(), "the late result did not reopen the job");
      assertTrue(failed.get("error").getAsString().startsWith("cancelled:"));
      assertFalse(failed.has("result"));
      Reply done = rig.delete(id, null);
      assertEquals(200, done.status);
      assertEquals("cancelled", done.json().get("status").getAsString());
    }
  }

  @Test void realWorkIsStoppedAndAccountedFor() throws Exception {
    FakeEngine engine = new FakeEngine();
    try (Rig rig = rig(engine, true, null, TestProblems.oneSlot())) {
      TestProblems.stopsSolverAndCpu(rig, "spin", SPIN);
    }
    try (Rig rig = rig(new FakeEngine(), true, null, TestProblems.oneSlot())) {
      TestProblems.queuedCancelAndSlotRelease(rig, "spin", "quick", SPIN);
    }
    try (Rig rig = rig(new FakeEngine(), true, null, TestProblems.oneSlot())) {
      TestProblems.deleteVersusFinish(rig, "quick");
    }
  }

  @Test void tenantsOwnTheirJobs() throws Exception {
    try (Rig rig = rig(new FakeEngine(), true, TOKENS, TestProblems.oneSlot())) {
      TestProblems.tenantIsolation(rig, "spin", SPIN, ALPHA, BETA);
    }
  }

  @Test void anInvalidRequestIsA422AndCreatesNothing() throws Exception {
    try (Rig rig = rig(new FakeEngine(), true, null, TestProblems.oneSlot())) {
      TestProblems.invalidRequestIsRefusedBeforeAnyJobExists(rig, "bad");
    }
  }

  @Test void theDefaultModeIsSynchronousAndExposesNoJobs() throws Exception {
    try (Rig rig = rig(new FakeEngine(), false, null, TestProblems.oneSlot())) {
      TestProblems.synchronousEngineHasNoJobs(rig, "quick");
      assertEquals(404, TestProblems.http("GET", rig.base + EngineHttp.OPENAPI_PATH, null, null).status);
    }
  }

  @Test void tokensGuardTheSynchronousEndpointToo() throws Exception {
    try (Rig rig = rig(new FakeEngine(), false, TOKENS, TestProblems.oneSlot())) {
      assertEquals(401, rig.post("quick", null).status);
      assertEquals(401, rig.post("quick", BETA + "x").status);
      Reply allowed = rig.post("quick", BETA);
      assertEquals(200, allowed.status);
      assertEquals(RESULT, allowed.body);
    }
    try (Rig rig = rig(new FakeEngine(), false, null, TestProblems.oneSlot())) {
      assertEquals(200, rig.post("quick", null).status, "no tokens configured: open as before");
    }
  }

  @Test void methodsAndMalformedIdsAreRefusedCleanly() throws Exception {
    try (Rig rig = rig(new FakeEngine(), true, null, TestProblems.oneSlot())) {
      Reply put = TestProblems.http("PUT", rig.base + Rig.JOBS + "00000000-0000-0000-0000-000000000000", null, "{}");
      assertEquals(405, put.status);
      assertEquals("GET, DELETE", put.header("Allow"));
      assertEquals(404, TestProblems.http("GET", rig.base + Rig.JOBS, null, null).status);
      assertEquals(404, TestProblems.http("GET", rig.base + Rig.JOBS + "a%20b", null, null).status);
      assertEquals(404, TestProblems.http("DELETE", rig.base + Rig.JOBS + "x/y", null, null).status);
      StringBuilder longId = new StringBuilder();
      for (int index = 0; index < 65; index++) longId.append('a');
      assertEquals(404, rig.get(longId.toString(), null).status);
      assertEquals(405, TestProblems.http("GET", rig.base + EngineHttp.SUBMIT_PATH, null, null).status);
      Reply unknown = rig.get("00000000-0000-0000-0000-000000000000", null);
      assertEquals(404, unknown.status);
      assertEquals("application/problem+json", unknown.header("Content-Type"));
      assertEquals(404, unknown.json().get("status").getAsInt());
    }
  }

  @Test void aFullEngineAnswers503WithRetryAfterAndRecovers() throws Exception {
    FakeEngine engine = new FakeEngine();
    EngineJobs.Settings tiny = new EngineJobs.Settings(1, 0, 8, 60000L, 5000L);
    try (Rig rig = rig(engine, true, null, tiny)) {
      String first = rig.submit("spin", null);
      rig.await(first, null, 20000, "running");
      Reply busy = rig.post("spin", null);
      assertEquals(503, busy.status, busy.body);
      assertEquals("5", busy.header("Retry-After"));
      assertEquals("application/problem+json", busy.header("Content-Type"));
      assertEquals(1, rig.jobs.retained());
      assertEquals(200, rig.delete(first, null).status);
      String again = rig.submit("quick", null);
      rig.await(again, null, 20000, "completed");
    }
  }

  @Test void theDeploymentOpenApiAdvertisesTheCancellationExtensionOnlyInAsyncMode() throws Exception {
    try (Rig rig = rig(new FakeEngine(), true, null, TestProblems.oneSlot())) {
      Reply reply = TestProblems.http("GET", rig.base + EngineHttp.OPENAPI_PATH, null, null);
      assertEquals(200, reply.status);
      JsonObject document = reply.json();
      JsonObject cancellation = document.getAsJsonObject("extensions").getAsJsonObject("cancellation");
      assertEquals(keys("supported", "idScope"), cancellation.keySet());
      assertTrue(cancellation.get("supported").getAsBoolean());
      assertEquals("attempt", cancellation.get("idScope").getAsString());
      JsonObject job = document.getAsJsonObject("paths").getAsJsonObject(EngineHttp.JOBS_PATH + "{id}");
      assertTrue(job.has("get"));
      assertTrue(job.has("delete"));
      assertTrue(job.getAsJsonObject("delete").getAsJsonObject("responses").has("202"));
      assertTrue(document.getAsJsonObject("paths").getAsJsonObject(EngineHttp.SUBMIT_PATH)
          .getAsJsonObject("post").getAsJsonObject("responses").has("202"));
      assertTrue(document.getAsJsonObject("components").getAsJsonObject("schemas").has("EngineJob"));
    }
  }

  @Test void anEnginesOwnOpenApiIsKeptAndExtendedWithoutBeingMutated() {
    String base = "{\"openapi\":\"3.1.0\",\"info\":{\"title\":\"Own\",\"version\":\"9.9\"},"
        + "\"x-bim-protocol-digest\":\"sha256-abc\",\"paths\":{\"" + EngineHttp.SUBMIT_PATH + "\":{\"post\":{"
        + "\"responses\":{\"200\":{\"description\":\"Completed result.\"}}}},"
        + "\"/health\":{\"get\":{\"responses\":{\"200\":{\"description\":\"ok\"}}}}},"
        + "\"components\":{\"schemas\":{\"BindingResult\":{\"type\":\"object\"}}}}";
    JsonObject extended = EngineHttp.deploymentOpenApi("ignored", base.getBytes(StandardCharsets.UTF_8));
    assertEquals("Own", extended.getAsJsonObject("info").get("title").getAsString());
    assertEquals("sha256-abc", extended.get("x-bim-protocol-digest").getAsString());
    assertEquals("Completed result.", extended.getAsJsonObject("paths").getAsJsonObject(EngineHttp.SUBMIT_PATH)
        .getAsJsonObject("post").getAsJsonObject("responses").getAsJsonObject("200").get("description").getAsString());
    assertTrue(extended.getAsJsonObject("paths").has("/health"));
    assertTrue(extended.getAsJsonObject("paths").has(EngineHttp.JOBS_PATH + "{id}"));
    assertTrue(extended.getAsJsonObject("extensions").has("cancellation"));
    assertEquals("object", extended.getAsJsonObject("components").getAsJsonObject("schemas")
        .getAsJsonObject("BindingResult").get("type").getAsString());
    assertFalse(new JsonParser().parse(base).getAsJsonObject().has("extensions"));
  }

  @Test void projectionToTheFourStateContract() {
    EngineJobs.Snapshot queued = new EngineJobs.Snapshot("q", EngineJobs.State.QUEUED, 7, null, null, null);
    EngineJobs.Snapshot cancelling = new EngineJobs.Snapshot("c", EngineJobs.State.CANCELLING, 7, null, null, "why");
    EngineJobs.Snapshot cancelled = new EngineJobs.Snapshot("x", EngineJobs.State.CANCELLED, 7, null, null,
        "requested by DELETE");
    EngineJobs.Snapshot completed = new EngineJobs.Snapshot("d", EngineJobs.State.COMPLETED, 7, RESULT, null, null);
    EngineJobs.Snapshot failed = new EngineJobs.Snapshot("f", EngineJobs.State.FAILED, 7, null, "bad \"x\"", null);
    assertEquals("{\"id\":\"q\",\"status\":\"queued\",\"created_at\":7}", EngineHttp.jobBody(queued));
    assertEquals("{\"id\":\"c\",\"status\":\"running\",\"created_at\":7}", EngineHttp.jobBody(cancelling));
    JsonObject projected = new JsonParser().parse(EngineHttp.jobBody(cancelled)).getAsJsonObject();
    assertEquals("failed", projected.get("status").getAsString());
    assertEquals("cancelled: requested by DELETE", projected.get("error").getAsString());
    assertEquals(new JsonParser().parse(RESULT),
        new JsonParser().parse(EngineHttp.jobBody(completed)).getAsJsonObject().get("result"));
    assertEquals("bad \"x\"", new JsonParser().parse(EngineHttp.jobBody(failed)).getAsJsonObject()
        .get("error").getAsString());
  }

  @Test void tokenConfigurationIsStrictAndAMalformedOneStopsTheEngine() {
    assertFalse(EngineHttp.Auth.parse(null).enabled());
    assertFalse(EngineHttp.Auth.parse("").enabled());
    EngineHttp.Auth auth = EngineHttp.Auth.parse(TOKENS);
    assertTrue(auth.enabled());
    assertEquals("alpha", auth.tenant("Bearer " + ALPHA));
    assertEquals("beta", auth.tenant("bearer " + BETA));
    assertNull(auth.tenant(null));
    assertNull(auth.tenant("Bearer"));
    assertNull(auth.tenant("Basic " + ALPHA));
    assertNull(auth.tenant("Bearer " + ALPHA + "0"));
    assertNull(auth.tenant("Bearer "));
    assertEquals("", EngineHttp.Auth.parse(null).tenant(null), "no tokens: everybody is the anonymous tenant");
    assertEquals("alpha", EngineHttp.Auth.parse(" alpha=" + ALPHA + " ").tenant("Bearer " + ALPHA));

    for (String malformed : new String[] {
        " ", ",", "alpha", "alpha=", "=" + ALPHA, "alpha=short", "alpha=" + ALPHA + ",",
        ",alpha=" + ALPHA, "alpha=" + ALPHA + ",,beta=" + BETA, "al pha=" + ALPHA,
        "alpha=" + ALPHA + ",alpha=" + BETA, "alpha=" + ALPHA + ",beta=" + ALPHA,
        "alpha=" + ALPHA + " " + ALPHA, "alpha=with space in the token!!"}) {
      assertThrows(IllegalStateException.class, () -> EngineHttp.Auth.parse(malformed), "[" + malformed + "]");
    }
  }

  @Test void settingsComeFromTheEnvironmentAndMalformedOnesStopTheEngine() {
    Map<String, String> env = new HashMap<String, String>();
    EngineHttp.Settings defaults = EngineHttp.Settings.fromEnvironment(env);
    assertEquals(8080, defaults.port());
    assertFalse(defaults.async());
    assertFalse(defaults.auth().enabled());

    env.put("PORT", "9191");
    env.put("ENGINE_JOB_MODE", "async");
    env.put("ENGINE_AUTH_TOKENS", TOKENS);
    EngineHttp.Settings async = EngineHttp.Settings.fromEnvironment(env);
    assertEquals(9191, async.port());
    assertTrue(async.async());
    assertTrue(async.auth().enabled());

    env.put("ENGINE_JOB_MODE", "sync");
    assertFalse(EngineHttp.Settings.fromEnvironment(env).async());
    env.put("ENGINE_JOB_MODE", "");
    assertFalse(EngineHttp.Settings.fromEnvironment(env).async());

    for (String[] bad : new String[][] {
        {"PORT", "abc"}, {"PORT", "0"}, {"PORT", "70000"}, {"PORT", "-5"},
        {"ENGINE_JOB_MODE", "ASYNC"}, {"ENGINE_JOB_MODE", "yes"},
        {"ENGINE_AUTH_TOKENS", "alpha=short"}, {"ENGINE_AUTH_TOKENS", "garbage"}}) {
      Map<String, String> broken = new HashMap<String, String>();
      broken.put(bad[0], bad[1]);
      assertThrows(IllegalStateException.class, () -> EngineHttp.Settings.fromEnvironment(broken),
          bad[0] + "=" + bad[1]);
    }
    Map<String, String> asyncBadLimit = new HashMap<String, String>();
    asyncBadLimit.put("ENGINE_JOB_MODE", "async");
    asyncBadLimit.put("ENGINE_JOB_MAX_CONCURRENT", "none");
    assertThrows(IllegalStateException.class, () -> EngineHttp.Settings.fromEnvironment(asyncBadLimit));
    Map<String, String> syncIgnoresLimits = new HashMap<String, String>();
    syncIgnoresLimits.put("ENGINE_JOB_MAX_CONCURRENT", "none");
    assertFalse(EngineHttp.Settings.fromEnvironment(syncIgnoresLimits).async());
  }
}
