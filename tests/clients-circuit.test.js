const { test } = require("node:test");
const assert = require("node:assert/strict");

const { supa, wp, breakers } = require("../scripts/lib/clients");

test("clients: exports breakers for supabase + wordpress", () => {
  assert.equal(typeof breakers.supabase.exec, "function");
  assert.equal(typeof breakers.wordpress.exec, "function");
  assert.equal(typeof breakers.supabase.trip, "function");
  assert.equal(typeof breakers.supabase.reset, "function");
});

test("clients: supa() fast-fails when supabase circuit is OPEN", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJ" + "x".repeat(150);
  breakers.supabase.trip();
  try {
    await assert.rejects(
      () => supa("GET", "articles"),
      (err) => err.code === "CIRCUIT_OPEN"
    );
  } finally {
    breakers.supabase.reset();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
});

test("clients: wp() fast-fails when wordpress circuit is OPEN", async () => {
  process.env.WP_USERNAME = "admin";
  process.env.WP_ADMIN_PASSWORD = "abcd efgh ijkl mnop qrst uvwx";
  breakers.wordpress.trip();
  try {
    await assert.rejects(
      () => wp("GET", "posts"),
      (err) => err.code === "CIRCUIT_OPEN"
    );
  } finally {
    breakers.wordpress.reset();
    delete process.env.WP_USERNAME;
    delete process.env.WP_ADMIN_PASSWORD;
  }
});

test("clients: supa() validates env before circuit", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  await assert.rejects(() => supa("GET", "x"), /SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing/);
});

test("clients: wp() validates env before circuit", async () => {
  delete process.env.WP_USERNAME;
  delete process.env.WP_ADMIN_PASSWORD;
  await assert.rejects(() => wp("GET", "x"), /WP_USERNAME or WP_ADMIN_PASSWORD missing/);
});
