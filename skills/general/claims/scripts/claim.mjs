#!/usr/bin/env node
// claim: atomic cross-session work claims (leases) for agent sessions.
//
//   claim acquire <key> --holder <label> [--ttl 15m] [--note text] [--json]
//   claim renew <key> --holder <label> [--ttl 15m] [--note text] [--json]
//   claim release <key> --holder <label> [--json]
//   claim release-all --holder <label> [--json]
//   claim steal <key> --holder <label> --reason <text> [--ttl 15m] [--note text] [--json]
//   claim show <key> [--json]
//   claim list [--stale] [--json]
//
// Exit codes: 0 done (acquired, renewed, released, shown), 3 held by someone else,
// 2 usage error, 1 claims store unavailable or other failure. Callers fail open on
// anything other than 0 or 3: warn and carry on without the lock.
//
// Storage: SQLite at ${AGENT_CLAIMS_DB:-~/.local/state/agent-claims/claims.db}. This
// backend is a prototype; a shared hosted service will replace it behind the same
// commands, output and exit codes.

import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_TTL_MS = 15 * 60_000;
export const MAX_TTL_MS = 2 * 60 * 60_000;
const EXIT = { ok: 0, error: 1, usage: 2, held: 3 };

class UsageError extends Error {}

export function normaliseKey(raw) {
  const text = String(raw ?? "").trim();
  const match = /^([A-Za-z][A-Za-z0-9-]*):(\S+)$/.exec(text);
  if (!match) throw new UsageError(`invalid key '${text}': use <kind>:<id>, e.g. ticket:LLE-123`);
  const kind = match[1].toLowerCase();
  const id = kind === "ticket" ? match[2].toUpperCase() : match[2].toLowerCase();
  return `${kind}:${id}`;
}

export function parseTtl(raw) {
  if (raw === undefined) return { ttlMs: DEFAULT_TTL_MS, capped: false };
  const match = /^(\d+)(s|m|h)?$/.exec(String(raw).trim());
  if (!match || Number(match[1]) <= 0) throw new UsageError(`invalid --ttl '${raw}': use e.g. 90s, 15m or 2h`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "m"];
  const ttlMs = Number(match[1]) * unit;
  return ttlMs > MAX_TTL_MS ? { ttlMs: MAX_TTL_MS, capped: true } : { ttlMs, capped: false };
}

function dbPath() {
  return process.env.AGENT_CLAIMS_DB || path.join(os.homedir(), ".local/state/agent-claims/claims.db");
}

// Test hook: AGENT_CLAIMS_NOW fixes the clock (milliseconds since the epoch or an ISO date).
function now() {
  const fixed = process.env.AGENT_CLAIMS_NOW;
  if (!fixed) return Date.now();
  const value = /^\d+$/.test(fixed) ? Number(fixed) : Date.parse(fixed);
  if (!Number.isFinite(value)) throw new UsageError(`invalid AGENT_CLAIMS_NOW '${fixed}'`);
  return value;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function ago(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function view(row, at) {
  if (!row) return null;
  return {
    key: row.key,
    holder: row.holder,
    note: row.note,
    host: row.host,
    ttl_seconds: Math.round(row.ttl_ms / 1000),
    acquired_at: iso(row.acquired_at),
    renewed_at: iso(row.renewed_at),
    expires_at: iso(row.expires_at),
    age_seconds: Math.round((at - row.acquired_at) / 1000),
    since_renewal_seconds: Math.round((at - row.renewed_at) / 1000),
    expired: row.expires_at <= at,
  };
}

function describe(row, at) {
  const left = row.expires_at - at;
  return [
    `  holder:   ${row.holder}`,
    `  note:     ${row.note || "(none)"}`,
    `  acquired: ${iso(row.acquired_at)} (${ago(at - row.acquired_at)} ago)`,
    `  renewed:  ${iso(row.renewed_at)} (${ago(at - row.renewed_at)} ago)`,
    `  expires:  ${iso(row.expires_at)} (${left > 0 ? `in ${ago(left)}` : `${ago(left)} ago`})`,
    `  host:     ${row.host || "(unknown)"}`,
  ].join("\n");
}

const COMMANDS = {
  acquire: { key: true, holder: true },
  renew: { key: true, holder: true },
  release: { key: true, holder: true },
  "release-all": { key: false, holder: true },
  steal: { key: true, holder: true },
  show: { key: true, holder: false },
  list: { key: false, holder: false },
};

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      holder: { type: "string" },
      ttl: { type: "string" },
      note: { type: "string" },
      reason: { type: "string" },
      stale: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) return { command: "help", values };
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`unknown command '${command}'`);
  if (rest.length !== (spec.key ? 1 : 0)) throw new UsageError(`'${command}' takes ${spec.key ? "one key" : "no key"}`);
  const holder = values.holder?.trim();
  if (spec.holder && !holder) throw new UsageError(`'${command}' needs --holder <label>`);
  if (command === "steal" && !values.reason?.trim()) throw new UsageError("'steal' needs --reason <text>");
  const { ttlMs, capped } = parseTtl(values.ttl);
  return {
    command,
    values,
    key: spec.key ? normaliseKey(rest[0]) : null,
    holder,
    ttlMs,
    capped,
  };
}

const HELP = `usage: claim <command> [options]

  acquire <key> --holder <label> [--ttl 15m] [--note text]   take the key, or exit 3 if held
  renew <key> --holder <label> [--ttl 15m] [--note text]     extend your lease (exit 3 if held by another)
  release <key> --holder <label>                              give the key back
  release-all --holder <label>                                release every key this holder has
  steal <key> --holder <label> --reason <text>                take a live claim (humans, dead holders)
  show <key>                                                  print the current holder, if any
  list [--stale]                                              live claims, or stale ones

All commands take --json. Leases default to 15m, capped at 2h.
Exit codes: 0 done, 3 held by someone else, 2 usage error, 1 store unavailable.
Database: \${AGENT_CLAIMS_DB:-~/.local/state/agent-claims/claims.db}
`;

export async function main(argv, out = process.stdout, err = process.stderr) {
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    err.write(`claim: ${error.message}\nRun 'claim --help' for usage.\n`);
    return EXIT.usage;
  }
  if (args.command === "help") {
    out.write(HELP);
    return EXIT.ok;
  }
  const json = Boolean(args.values.json);
  const emit = (payload, text) => out.write(json ? `${JSON.stringify(payload)}\n` : `${text}\n`);

  let store;
  try {
    const at = now();
    if (args.capped) err.write(`claim: warning: --ttl capped at ${MAX_TTL_MS / 3_600_000}h\n`);
    const { openSqliteStore } = await import("./lib/sqlite-store.mjs");
    store = await openSqliteStore(dbPath());
    const { command, key, holder, ttlMs } = args;
    const note = args.values.note;

    if (command === "list") {
      const { claims } = store.list({ now: at, stale: Boolean(args.values.stale) });
      const label = args.values.stale ? "stale claims" : "claims";
      emit(
        { ok: true, status: "listed", stale: Boolean(args.values.stale), claims: claims.map((row) => view(row, at)) },
        claims.length === 0
          ? `no ${label}`
          : claims.map((row) => `${row.key}\n${describe(row, at)}`).join("\n\n"),
      );
      return EXIT.ok;
    }

    if (command === "release-all") {
      const { keys } = store.releaseAll({ holder, now: at });
      emit({ ok: true, status: "released", holder, keys }, keys.length ? `released: ${keys.join(", ")}` : "nothing held");
      return EXIT.ok;
    }

    let result;
    if (command === "acquire") result = store.acquire({ key, holder, ttlMs, note, now: at });
    else if (command === "renew") result = store.renew({ key, holder, ttlMs, note, now: at });
    else if (command === "release") result = store.release({ key, holder, now: at });
    else if (command === "steal") result = store.steal({ key, holder, ttlMs, note, reason: args.values.reason, now: at });
    else result = store.show({ key, now: at });

    const payload = { ok: true, status: result.status, key, claim: view(result.claim, at) };
    if (result.previous !== undefined) payload.previous = view(result.previous, at);
    const text =
      result.status === "free"
        ? `free: ${key}`
        : result.status === "stolen" && result.previous
          ? `stolen: ${key} (from ${result.previous.holder})\n${describe(result.claim, at)}`
          : `${result.status}: ${key}\n${describe(result.claim, at)}`;
    emit(payload, text);
    return result.status === "held" && command !== "show" ? EXIT.held : EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`claim: ${error.message}\n`);
      return EXIT.usage;
    }
    const message = String(error?.message ?? error);
    err.write(`claim: warning: claims store unavailable (${message}); proceed without a lock\n`);
    if (json) out.write(`${JSON.stringify({ ok: false, status: "error", error: message, fail_open: true })}\n`);
    return EXIT.error;
  } finally {
    try {
      store?.close();
    } catch {}
  }
}

if (process.argv[1]?.endsWith("claim.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
