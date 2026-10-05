import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, usingSupabase } from "./config.js";

/**
 * Device-scoped persistence.
 * - With SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set: rows go to Supabase
 *   PostgREST (tables: watchlist, orders, research_logs, device_settings)
 *   every row carries device_id — see supabase/schema.sql.
 * - Otherwise: a local JSON file (backend/data/store.json) so the stack
 *   runs end-to-end on any machine with zero external services.
 */

const FILE = path.join(config.dataDir, "store.json");
/**
 * Tables the local JSON store knows about.
 *
 * The DEX observation tables are here because the collector must run with no
 * database configured — that is how the app runs on a fresh machine, and a
 * collector that silently no-ops off-Supabase would leave the feature permanently
 * untrained while appearing healthy.
 */
const COLS = [
  "watchlist",
  "orders",
  "research_logs",
  "device_settings",
  "paper_calls",
  "dex_snapshots",
  "whale_flows",
  "whale_profiles",
];

function blank() {
  const o = {};
  for (const c of COLS) o[c] = [];
  return o;
}

let cache = null;
function readLocal() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    cache = blank();
  }
  for (const c of COLS) cache[c] ||= [];
  return cache;
}
function writeLocal() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(readLocal(), null, 2));
}

async function sb(table, params) {
  const qs = new URLSearchParams({ device_id: `eq.${params.deviceId}`, ...(params.order ? { order: params.order } : {}) }).toString();
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?${qs}`, {
    headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`supabase ${table}: ${res.status}`);
  return res.json();
}

export async function listCollection(table, deviceId, order = "created_at.desc") {
  if (usingSupabase) return sb(table, { deviceId, order });
  // A table with no rows yet is `undefined` in the local JSON store, not `[]`.
  // Calling `.filter` on it threw a 500, which meant every newly added
  // collection — proposals, session keys — returned an error on first read
  // instead of an empty list. An absent collection is an empty collection.
  return (readLocal()[table] ?? [])
    .filter((r) => r.device_id === deviceId)
    .sort((a, b) => String(b[order.split(".")[0]] || "").localeCompare(String(a[order.split(".")[0]] || "")));
}

/**
 * Read a table across *all* devices, newest first.
 *
 * This exists for one reason: the self-improvement loop learns from every
 * user's settled paper calls, because a shared model should be trained on
 * everything the app has observed. Per-device reads (`listCollection`) would
 * each user get a private model trained on their own handful of calls, which
 * is both worse and statistically hopeless.
 */
export async function listAllRows(table, order = "created_at.desc", limit = 5000) {
  if (usingSupabase) {
    const qs = new URLSearchParams({ order, limit: String(limit) }).toString();
    const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?${qs}`, {
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`supabase ${table}: ${res.status}`);
    return res.json();
  }
  const key = order.split(".")[0];
  const dir = order.split(".")[1] === "asc" ? 1 : -1;
  return (readLocal()[table] ?? [])
    .slice()
    .sort((a, b) => String(a[key] || "").localeCompare(String(b[key] || "")) * dir)
    .slice(0, limit);
}

export async function insertRow(table, row) {
  if (usingSupabase) {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}`, {
      method: "POST",
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`supabase insert ${table}: ${res.status}`);
    return (await res.json())[0];
  }
  const db = readLocal();
  const record = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
  db[table].push(record);
  writeLocal();
  return record;
}

/**
 * Insert many rows in one request.
 *
 * The DEX collector produces tens of rows per tick. Issuing one POST per row
 * would spend the whole tick in HTTP round trips and, on the local JSON path,
 * would rewrite the entire store file once per row — turning a 30-second poll
 * into 30 rewrites of a growing file.
 *
 * Supabase's PostgREST accepts an array body for a bulk insert. The local store
 * appends them in one write for the same reason.
 *
 * Returns the number stored, never a partial truth: on failure it returns 0 and
 * logs, because a collector that reports "stored 30" when it stored 0 is worse
 * than one that reports nothing. `dexwatch.collectOnce` surfaces that count and
 * a zero must be visible.
 */
export async function insertRows(table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  if (usingSupabase) {
    try {
      const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          apikey: config.supabaseKey,
          Authorization: `Bearer ${config.supabaseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`supabase insert ${table}: ${res.status}`);
      return rows.length;
    } catch (err) {
      console.warn(`[store] bulk insert into ${table} failed:`, err.message);
      return 0;
    }
  }

  try {
    const db = readLocal();
    // `db[table]` can be undefined for a table added after this store was
    // first written. Initialising it here rather than trusting blank() avoids a
    // TypeError that would take down the collector on a fresh data directory.
    if (!Array.isArray(db[table])) db[table] = [];
    const stamped = rows.map((r) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...r }));
    db[table].push(...stamped);
    writeLocal();
    return stamped.length;
  } catch (err) {
    console.warn(`[store] bulk insert into ${table} failed:`, err.message);
    return 0;
  }
}

/**
 * Patch an existing row.
 *
 * This exists because the paper ledger settles calls in place: a call is opened
 * once, then weeks later its outcome is written. Without a durable update,
 * settling only mutated the in-memory copy — fine against the local JSON file
 * (a shared object reference) but silently a no-op against Supabase, where the
 * rows are parsed out of a fresh HTTP response and thrown away. Production would
 * have re-settled every call on every tick forever, and the training set would
 * never contain a single settled row.
 *
 * @param table  table name
 * @param id     primary key (`id` uuid on the app tables, `id` text on model_registry)
 * @param patch  columns to set
 */
export async function updateRow(table, id, patch) {
  if (id == null) throw new Error("updateRow needs an id");
  if (usingSupabase) {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`supabase ${table} update: ${res.status}`);
    return { ...patch, id };
  }
  const db = readLocal();
  const row = (db[table] ?? []).find((r) => String(r.id) === String(id));
  if (!row) return null;
  Object.assign(row, patch);
  writeLocal();
  return row;
}

export async function deleteRow(table, deviceId, matcher) {
  if (usingSupabase) {
    const qs = new URLSearchParams({ device_id: `eq.${deviceId}`, ...matcher }).toString();
    const res = await fetch(`${config.supabaseUrl}/rest/v1/${table}?${qs}`, {
      method: "DELETE",
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` },
    });
    return res.ok;
  }
  const db = readLocal();
  const before = db[table].length;
  db[table] = db[table].filter((r) => !(r.device_id === deviceId && matcherMatches(r, matcher)));
  writeLocal();
  return db[table].length < before;
}

function matcherMatches(row, matcher) {
  return Object.entries(matcher).every(([k, v]) => String(row[k]) === String(v));
}

/** Upsert a single settings object per device (settings collection keyed by device). */
export async function getSettings(deviceId) {
  const rows = await listCollection("device_settings", deviceId);
  return rows[0]?.settings ?? null;
}
export async function putSettings(deviceId, settings) {
  const existing = usingSupabase
    ? (await sbGetSettingsRow(deviceId))
    : readLocal().device_settings.find((r) => r.device_id === deviceId);
  if (existing) {
    if (usingSupabase) {
      await fetch(`${config.supabaseUrl}/rest/v1/device_settings?id=eq.${existing.id}`, {
        method: "PATCH",
        headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
    } else {
      existing.settings = settings;
      writeLocal();
    }
    return settings;
  }
  const row = await insertRow("device_settings", { device_id: deviceId, settings });
  return row.settings;
}

async function sbGetSettingsRow(deviceId) {
  const rows = await sb("device_settings", { deviceId });
  return rows[0];
}

/** Distinct device ids that have watchlist rows (targets for the auto-poller). */
export async function devicesWithWatchlist() {
  if (usingSupabase) {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/watchlist?select=device_id&distinct=true`, {
      headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` },
    });
    if (!res.ok) return [];
    return (await res.json()).map((r) => r.device_id);
  }
  return [...new Set(readLocal().watchlist.map((r) => r.device_id))];
}

/** AES-256-GCM encryption of secret material keyed by JWT secret + device id. */
export function encryptSecret(plaintext, deviceId) {
  const key = crypto.createHash("sha256").update(`${config.jwtSecret}:${deviceId}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload, deviceId) {
  try {
    const [ivHex, tagHex, dataHex] = String(payload).split(":");
    const key = crypto.createHash("sha256").update(`${config.jwtSecret}:${deviceId}`).digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    d.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([d.update(Buffer.from(dataHex, "hex")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

let lastResult = null;
let cachedAt = 0;

/**
 * Verify the Supabase connection actually works, rather than assuming it does.
 *
 * Why this exists. `usingSupabase` is true when a URL and a key are *present*. It
 * says nothing about whether either is valid. A truncated paste, a key from the
 * wrong project, or a revoked key all leave `usingSupabase` true while every
 * single write fails with a 401 - and `/api/health` cheerfully reported
 * `storage: supabase` the whole time.
 *
 * That is the worst possible failure shape for a health check: it reports the
 * deployment as healthy while it is quietly losing every write. Health has to
 * answer "is this working", not "is this configured".
 *
 * One cheap round trip against a table that always exists, with a short timeout.
 * Deliberately not cached beyond `ttlMs`: the whole point is to notice a key that
 * was revoked or a project that went to sleep.
 */
export async function verifySupabase({ ttlMs = 30_000 } = {}) {
  // `./config.js`, not `../config.js` — this file lives in `src/`, alongside it.
  // The dynamic import also keeps `config` out of the module's static graph, so a
  // config problem surfaces here with this function's error rather than as an
  // unrelated import failure at module load.
  const { config, usingSupabase } = await import("./config.js");
  if (!usingSupabase) {
    return {
      status: "not_configured",
      connected: false,
      detail: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing; using the local JSON store",
    };
  }
  const cached = lastResult && Date.now() - cachedAt < ttlMs ? lastResult : null;
  if (cached) return cached;

  let result;
  try {
    // A table the app always has. `limit=1` so the response is empty and cheap.
    // This is a real authenticated request: PostgREST validates the key before
    // it ever looks at the table, so a bad key fails here exactly as it would on
    // a write.
    const res = await fetch(`${config.supabaseUrl}/rest/v1/model_registry?select=id&limit=1`, {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      result = {
        status: "connected",
        connected: true,
        detail: "authenticated and reachable",
        latencyMs: null,
      };
    } else {
      // The body names the failure, and the distinction matters: an invalid key is
      // a configuration mistake the user must fix, while a 5xx is the provider
      // having a bad day and needs no intervention.
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) detail += `: ${body.message}`;
      } catch {
        // Non-JSON error body; the status is all we get.
      }
      result = {
        status: res.status === 401 || res.status === 403 ? "unauthorized" : "error",
        connected: false,
        detail,
        hint:
          res.status === 401
            ? "SUPABASE_SERVICE_ROLE_KEY is invalid for this project. Copy it again from Project Settings -> API -> Service Role. If it was pasted in chat or shared anywhere, rotate it."
            : null,
      };
    }
  } catch (err) {
    result = {
      status: "unreachable",
      connected: false,
      detail: err?.message ?? String(err),
      hint: "The project URL could not be reached. Check the URL, and whether the project is paused or has been deleted.",
    };
  }

  lastResult = result;
  cachedAt = Date.now();
  return result;
}
