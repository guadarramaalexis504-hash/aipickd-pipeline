const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { ping } = require("../scripts/lib/heartbeat");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

test("heartbeat: skips silently when env var missing", async () => {
  delete process.env.HEALTHCHECK_URL_NONEXISTENT_TEST;
  const r = await ping("nonexistent_test");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no HEALTHCHECK_URL_/);
});

test("heartbeat: success ping POSTs to base URL", async () => {
  let received = null;
  const { url, server } = await startServer((req, res) => {
    received = { method: req.method, url: req.url };
    res.writeHead(200);
    res.end("OK");
  });
  process.env.HEALTHCHECK_URL_TEST_SUCCESS = url;
  try {
    const r = await ping("TEST_SUCCESS");
    assert.equal(r.ok, true);
    assert.equal(received.method, "POST");
    assert.equal(received.url, "/");
  } finally {
    server.close();
    delete process.env.HEALTHCHECK_URL_TEST_SUCCESS;
  }
});

test("heartbeat: start state appends /start", async () => {
  let path = null;
  const { url, server } = await startServer((req, res) => {
    path = req.url;
    res.writeHead(200);
    res.end();
  });
  process.env.HEALTHCHECK_URL_TEST_START = url;
  try {
    await ping("TEST_START", { state: "start" });
    assert.equal(path, "/start");
  } finally {
    server.close();
    delete process.env.HEALTHCHECK_URL_TEST_START;
  }
});

test("heartbeat: fail with exitCode appends /<code>", async () => {
  let path = null;
  const { url, server } = await startServer((req, res) => {
    path = req.url;
    res.writeHead(200);
    res.end();
  });
  process.env.HEALTHCHECK_URL_TEST_FAIL = url;
  try {
    await ping("TEST_FAIL", { state: "fail", exitCode: 2 });
    assert.equal(path, "/2");
  } finally {
    server.close();
    delete process.env.HEALTHCHECK_URL_TEST_FAIL;
  }
});

test("heartbeat: never throws — returns reason on network error", async () => {
  process.env.HEALTHCHECK_URL_TEST_BAD = "http://127.0.0.1:1/nope";
  try {
    const r = await ping("TEST_BAD");
    assert.equal(r.ok, false);
    assert.ok(r.reason);
  } finally {
    delete process.env.HEALTHCHECK_URL_TEST_BAD;
  }
});
