import { Database, GPTYar, Bale } from "./clients.js";
import { assert, AppError } from "./domain.js";
import { open, seal, hash } from "./crypto.js";
export function context(env, options = {}) {
  const db = new Database(env, options.dbTimeout || 8000),
    gpt = new GPTYar(env.GPTYAR_EXTENSION_VERSION || "4.6.5");
  const ctx = {
    env,
    db,
    gpt,
    encrypt: (s, p) => seal(s, p, env.GPTYAR_ENCRYPTION_KEY),
    decrypt: (s, p) => open(s, p, env.GPTYAR_ENCRYPTION_KEY),
    async setting(key) {
      return (await db.one("system_settings", `key=eq.${key}`))?.value || {};
    },
    async set(key, value) {
      await db.request(
        "system_settings?on_conflict=key",
        "POST",
        { key, value },
        "resolution=merge-duplicates,return=representation",
      );
    },
    async secret(key) {
      const row = await db.one("secure_settings", `key=eq.${key}`);
      assert(row, "CONNECTION_NOT_CONFIGURED", 409);
      return open(row.ciphertext, `setting:${key}`, env.GPTYAR_ENCRYPTION_KEY);
    },
    async saveSecret(key, value, session) {
      const ciphertext = await seal(
        value,
        `setting:${key}`,
        env.GPTYAR_ENCRYPTION_KEY,
      );
      await db.request(
        "secure_settings?on_conflict=key",
        "POST",
        { key, ciphertext, updated_by: session || null },
        "resolution=merge-duplicates,return=representation",
      );
    },
    async bot() {
      return new Bale(await ctx.secret("bale_bot"));
    },
    async event(code, order = null, level = "error") {
      await db.insert("system_events", {
        event_code: code,
        order_id: order,
        level,
      });
    },
    async audit(session, action, target, metadata = {}) {
      await db.insert("audit_logs", {
        session_id: session,
        action,
        target_id: target,
        metadata,
      });
    },
    async rate(key, limit, seconds) {
      assert(
        await db.rpc("rate", {
          p_key: await hash(key),
          p_limit: limit,
          p_seconds: seconds,
        }),
        "RATE_LIMITED",
        429,
      );
    },
    async enqueue(kind, id, key, payload = {}) {
      await db.request(
        "outbox_jobs?on_conflict=dedupe_key",
        "POST",
        { kind, aggregate_id: String(id), dedupe_key: key, payload },
        "resolution=ignore-duplicates,return=representation",
      );
    },
    async storage(path, method = "POST", body) {
      const response = await fetch(`${env.SUPABASE_URL}/storage/v1/${path}`, {
        method,
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          ...(body instanceof Uint8Array
            ? { "Content-Type": "application/zip" }
            : { "Content-Type": "application/json" }),
        },
        body:
          body === undefined
            ? undefined
            : body instanceof Uint8Array
              ? new Uint8Array(body).buffer
              : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      assert(response.ok, "STORAGE_ERROR", 502);
      return response;
    },
    async sign(bucket, path) {
      const r = await (
        await ctx.storage(`object/sign/${bucket}/${path}`, "POST", {
          expiresIn: 3600,
        })
      ).json();
      return env.SUPABASE_URL + "/storage/v1" + r.signedURL;
    },
    async scope(profile) {
      assert(
        env.GPTYAR_ACCOUNT_ID &&
          String(profile.account.id) === env.GPTYAR_ACCOUNT_ID,
        "ACCOUNT_NOT_ALLOWED",
        403,
      );
    },
  };
  return ctx;
}
export async function authenticate(ctx, req) {
  const bearer = req.headers.get("Authorization") || "";
  assert(/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer), "SESSION_REQUIRED", 401);
  const session = await ctx.db.one(
    "admin_sessions",
    `session_hash=eq.${await hash(bearer.slice(7))}&revoked_at=is.null&expires_at=gt.${new Date().toISOString()}`,
  );
  assert(session, "SESSION_EXPIRED", 401);
  const token = await ctx.decrypt(
    session.token_ciphertext,
    "admin-session:" + session.session_hash,
  );
  let profile;
  try {
    const auth = await ctx.gpt.authorize(token);
    profile = auth.profile;
    await ctx.scope(profile);
  } catch (e) {
    if (e.status === 401 || e.status === 403)
      await ctx.db.patch("admin_sessions", `id=eq.${session.id}`, {
        revoked_at: new Date().toISOString(),
      });
    throw e;
  }
  assert(
    String(profile.account.id) === session.account_id,
    "ACCOUNT_NOT_ALLOWED",
    403,
  );
  await ctx.rate("session:" + session.id, 180, 60);
  return { session, token, profile };
}
export async function bodyJSON(req, max = 450000) {
  assert(
    req.headers.get("Content-Type")?.startsWith("application/json"),
    "JSON_REQUIRED",
    415,
  );
  assert(
    Number(req.headers.get("Content-Length") || 0) <= max,
    "BODY_TOO_LARGE",
    413,
  );
  const reader = req.body?.getReader();
  assert(reader, "INVALID_JSON");
  let size = 0,
    parts = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError("BODY_TOO_LARGE", 413);
    }
    parts.push(r.value);
  }
  const bytes = new Uint8Array(size);
  let p = 0;
  for (const b of parts) {
    bytes.set(b, p);
    p += b.length;
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError("INVALID_JSON");
  }
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "INVALID_JSON",
  );
  return value;
}

export async function readBytes(req, max) {
  const reader = req.body?.getReader();
  assert(reader, "EMPTY_BODY");
  let size = 0,
    parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError("BODY_TOO_LARGE", 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let p = 0;
  for (const b of parts) {
    bytes.set(b, p);
    p += b.length;
  }
  return bytes;
}
