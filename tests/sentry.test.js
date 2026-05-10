const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const sentry = require("../scripts/lib/sentry");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

test("sentry: noop when SENTRY_DSN unset", async () => {
  delete process.env.SENTRY_DSN;
  sentry._resetCache();
  const r = await sentry.captureException(new Error("x"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /SENTRY_DSN not set/);
});

test("sentry: invalid DSN disables silently", async () => {
  process.env.SENTRY_DSN = "not-a-url";
  sentry._resetCache();
  const r = await sentry.captureException(new Error("x"));
  assert.equal(r.ok, false);
  delete process.env.SENTRY_DSN;
  sentry._resetCache();
});

test("sentry: posts event when DSN valid", async () => {
  let received = null;
  const { url: serverUrl, server } = await startServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received = { method: req.method, url: req.url, body };
      res.writeHead(200);
      res.end('{"id":"evt"}');
    });
  });

  // Build DSN that points at our test server's /api/<project>/store/ path.
  const u = new URL(serverUrl);
  process.env.SENTRY_DSN = `http://testkey@${u.host}/42`;
  sentry._resetCache();

  try {
    const r = await sentry.captureException(new Error("test boom"), {
      tags: { stage: "test" },
    });
    assert.equal(r.ok, true);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/api/42/store/");
    const parsed = JSON.parse(received.body);
    assert.equal(parsed.exception.values[0].value, "test boom");
    assert.equal(parsed.tags.stage, "test");
  } finally {
    server.close();
    delete process.env.SENTRY_DSN;
    sentry._resetCache();
  }
});

test("sentry: installGlobalHandlers is idempotent", () => {
  process.__aipickdSentryInstalled = false;
  sentry.installGlobalHandlers();
  sentry.installGlobalHandlers(); // shouldn't double-register
  assert.equal(process.__aipickdSentryInstalled, true);
});
