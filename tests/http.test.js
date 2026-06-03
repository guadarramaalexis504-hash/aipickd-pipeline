const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const dns = require("node:dns");

const { fetchWithRetry, parseRetryAfter } = require("../scripts/lib/http");

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

test("parseRetryAfter: numeric seconds", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("0"), 0);
});

test("fetchWithRetry: prefers IPv4 DNS results for Hostinger WordPress", () => {
  assert.equal(dns.getDefaultResultOrder(), "ipv4first");
});

test("parseRetryAfter: HTTP date", () => {
  const future = new Date(Date.now() + 10000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms >= 8000 && ms <= 12000, `expected ~10000ms, got ${ms}`);
});

test("parseRetryAfter: invalid returns null", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("garbage"), null);
});

test("fetchWithRetry: succeeds on first try", async () => {
  const { url, server } = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  try {
    const res = await fetchWithRetry(url);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test("fetchWithRetry: retries on 503 then succeeds", async () => {
  let calls = 0;
  const { url, server } = await startServer((_req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(503);
      res.end("busy");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  try {
    const res = await fetchWithRetry(url, {}, { baseDelay: 5, retries: 5 });
    assert.equal(res.status, 200);
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test("fetchWithRetry: respects Retry-After on 429", async () => {
  let calls = 0;
  const { url, server } = await startServer((_req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { "retry-after": "0" });
      res.end("slow down");
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  try {
    const res = await fetchWithRetry(url, {}, { baseDelay: 5, retries: 2 });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});

test("fetchWithRetry: does NOT retry on 404", async () => {
  let calls = 0;
  const { url, server } = await startServer((_req, res) => {
    calls++;
    res.writeHead(404);
    res.end();
  });
  try {
    const res = await fetchWithRetry(url, {}, { baseDelay: 5, retries: 3 });
    assert.equal(res.status, 404);
    assert.equal(calls, 1);
  } finally {
    server.close();
  }
});

test("fetchWithRetry: gives up after max retries on 500", async () => {
  let calls = 0;
  const { url, server } = await startServer((_req, res) => {
    calls++;
    res.writeHead(500);
    res.end("nope");
  });
  try {
    const res = await fetchWithRetry(url, {}, { baseDelay: 5, retries: 2 });
    assert.equal(res.status, 500);
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test("fetchWithRetry: timeout aborts and retries", async () => {
  let calls = 0;
  const { url, server } = await startServer((_req, res) => {
    calls++;
    if (calls === 1) {
      setTimeout(() => res.end("late"), 200);
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  });
  try {
    const res = await fetchWithRetry(url, {}, { baseDelay: 5, retries: 2, timeout: 50 });
    assert.equal(res.status, 200);
    assert.ok(calls >= 2);
  } finally {
    server.close();
  }
});
