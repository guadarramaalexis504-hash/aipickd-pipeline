"use strict";

const WRITE_FLAGS = new Set(["--go", "--fix", "--apply", "--confirm"]);

function hasWriteFlag(argv = process.argv.slice(2), allowedFlags = WRITE_FLAGS) {
  return argv.some((arg) => allowedFlags.has(arg));
}

function readFlag(argv, name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function readIntFlag(argv, name, fallback) {
  const raw = readFlag(argv, name, null);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { WRITE_FLAGS, hasWriteFlag, readFlag, readIntFlag };
