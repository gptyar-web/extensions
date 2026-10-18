import test from "node:test";
import assert from "node:assert/strict";
import {
  checkLimits,
  expiry,
  positiveInt,
  quote,
  updateResponse,
  verifyTransaction,
} from "../supabase/functions/_shared/domain.js";
import { open, random, seal } from "../supabase/functions/_shared/crypto.js";
import { Bale, GPTYar } from "../supabase/functions/_shared/clients.js";
import { createHandler } from "../supabase/functions/_shared/handler.js";
import { inspectZip } from "../supabase/functions/_shared/archive.js";
import { strToU8, zipSync } from "fflate";
test("Persian/Arabic/Latin numbers; invalid or fractional quantities rejected", () => {
  for (const n of ["۱۲", "١٢", "12"]) assert.equal(positiveInt(n), 12);
  for (const n of ["-1", "1.2", "Infinity", "0", "۲x"]) {
    assert.throws(() => positiveInt(n));
  }
});
test("renewal preserves remaining validity; expired begins now; month exactly 30 UTC days", () => {
  const now = Date.parse("2026-10-18T08:00:00Z");
  assert.equal(
    expiry("2026-10-20T08:00:00Z", "day", 2, now),
    "2026-10-22T08:00:00.000Z",
  );
  assert.equal(
    expiry("2026-10-01T00:00:00Z", "month", 1, now),
    "2026-11-17T08:00:00.000Z",
  );
});
test("pricing and discounts calculated in integer rials, minimum payable 1 rial", () => {
  const r = {
    enabled: true,
    min_quantity: 1,
    max_quantity: 60,
    unit_price_rial: 350000,
  };
  assert.equal(quote(r, 2, { kind: "percent", value: 10 }).total_rial, 630000);
  assert.equal(quote(r, 1, { kind: "fixed", value: 9999999 }).total_rial, 1);
  assert.throws(() => quote({ ...r, enabled: false }, 1));
  assert.throws(() => quote(r, 61));
});
test("enterprise UI defaults are not treated as verified limits", () => {
  assert.throws(
    () =>
      checkLimits(
        { account: { type: "ENTERPRISE" } },
        { subscribers: [] },
        expiry(null, "day", 1),
        "purchase",
      ),
    /LIMITS_NOT_VERIFIED/,
  );
  assert.throws(
    () =>
      checkLimits(
        { account: { limits: { maxUsers: 1, maxDurationDays: 60 } } },
        { subscribers: [{}] },
        expiry(null, "day", 1),
        "purchase",
      ),
    /ENTERPRISE_USER_LIMIT/,
  );
  assert.throws(
    () =>
      checkLimits(
        { account: { limits: { maxUsers: 20, maxDurationDays: 1 } } },
        { subscribers: [] },
        expiry(null, "day", 2),
        "purchase",
      ),
    /ENTERPRISE_EXPIRY_LIMIT/,
  );
});
test("transaction must match payer, amount, currency, payload and paid status", () => {
  const o = { id: "o", bale_user_id: "12", total_rial: 1000 },
    p = {
      currency: "IRR",
      invoice_payload: "o",
      total_amount: 1000,
      telegram_payment_charge_id: "tx",
    },
    tx = { id: "tx", status: "paid", userID: 12, amount: 1000 };
  assert(verifyTransaction(o, p, tx, 12));
  for (
    const [k, v] of [
      ["status", "pending"],
      ["amount", 1],
      ["userID", 13],
      ["id", "other"],
    ]
  ) {
    assert.throws(() => verifyTransaction(o, p, { ...tx, [k]: v }, 12));
  }
  assert.throws(() => verifyTransaction(o, { ...p, currency: "IRT" }, tx, 12));
});
test("AES-GCM encrypts with purpose binding; wrong key and tampering rejected", async () => {
  const key = Buffer.alloc(32, 5).toString("base64"),
    cipher = await seal("private-token", "setting:bot", key);
  assert(!cipher.includes("private-token"));
  assert.equal(await open(cipher, "setting:bot", key), "private-token");
  await assert.rejects(open(cipher, "setting:wallet", key));
  await assert.rejects(
    open(cipher, "setting:bot", Buffer.alloc(32, 6).toString("base64")),
  );
  assert.match(random(), /^[A-Za-z0-9_-]{43}$/);
});
test("admin auth requires actual management capability and account scope, not prefix", async () => {
  let calls = [];
  const transport = async (url, o) => {
    calls.push({ url, o });
    return new Response(
      JSON.stringify(
        url.endsWith("/validate")
          ? {
            message: "ok",
            account: { id: "owner" },
            agent: { name: "admin" },
          }
          : { accountId: "owner", subscribers: [] },
      ),
    );
  };
  const g = new GPTYar("4.6.5", transport);
  await assert.rejects(g.authorize("normal"), /ADMIN_TOKEN_REQUIRED/);
  assert.equal(calls.length, 0);
  const auth = await g.authorize("@test-only");
  assert.equal(auth.profile.account.id, "owner");
  assert.equal(JSON.parse(calls[0].o.body).version, "4.6.5");
  assert(calls[1].url.endsWith("/subscribers/all"));
  const denied = new GPTYar(
    "4.6.5",
    async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith("/validate")
            ? { message: "ok", account: { id: "owner" }, agent: "agent" }
            : { error: "forbidden" },
        ),
        { status: url.endsWith("/validate") ? 200 : 403 },
      ),
  );
  await assert.rejects(denied.authorize("@fake"), /GPTYAR_UNAUTHORIZED/);
});
test("Bale calls official methods and isolates API failures", async () => {
  let seen;
  const bot = new Bale("test-only", async (u, o) => {
    seen = { u, o };
    return new Response(JSON.stringify({ ok: true, result: true }));
  });
  await bot.call("answerPreCheckoutQuery", {
    pre_checkout_query_id: "id",
    ok: false,
  });
  assert.equal(
    seen.u,
    "https://tapi.bale.ai/bottest-only/answerPreCheckoutQuery",
  );
  assert.equal(JSON.parse(seen.o.body).ok, false);
});
test("handler blocks foreign origins, unauthenticated admin and worker requests", async () => {
  const handle = createHandler({
    ADMIN_ORIGINS: "https://admin.example",
    SUPABASE_URL: "https://test.supabase.co",
  });
  const r = await handle(
    new Request(
      "https://test.supabase.co/functions/v1/gptyar-api/api/account",
      { headers: { Origin: "https://attacker.example" } },
    ),
  );
  assert.equal(r.status, 403);
  const unauth = await handle(
    new Request(
      "https://test.supabase.co/functions/v1/gptyar-api/api/account",
      { headers: { Origin: "https://admin.example" } },
    ),
  );
  assert.equal(unauth.status, 401);
  assert.equal(
    (
      await handle(
        new Request(
          "https://test.supabase.co/functions/v1/gptyar-api/jobs/run",
          { method: "POST" },
        ),
      )
    ).status,
    401,
  );
});
test("hosted Supabase internal HTTP uses its TLS gateway; client headers cannot bypass HTTPS", async () => {
  const internal = "http://edge-runtime/gptyar-api/health";
  const handle = createHandler({ SUPABASE_URL: "https://fixture.supabase.co" });
  assert.equal(
    (await handle(
      new Request(internal, {
        headers: { "X-Forwarded-Proto": "https" },
      }),
    )).status,
    400,
  );
  const hosted = createHandler({
    SUPABASE_URL: "https://fixture.supabase.co",
    DENO_DEPLOYMENT_ID: "fixture-runtime-id",
  });
  assert.equal((await hosted(new Request(internal))).status, 200);
});
test("incomplete infrastructure is explicit and cannot accept administrative tokens", async () => {
  const handle = createHandler({ SUPABASE_URL: "https://fixture.supabase.co" });
  const health = await handle(new Request("https://fixture.supabase.co/health"));
  assert.equal((await health.json()).security_configured, false);
  const login = await handle(new Request("https://fixture.supabase.co/api/login", {
    method: "POST", headers: { Origin: "https://gptyar-web.github.io", "Content-Type": "application/json" },
    body: JSON.stringify({ token: "@fixture-unused" }),
  }));
  assert.equal(login.status, 503);
  assert.equal((await login.json()).error, "INITIAL_SETUP_REQUIRED");
});
test("optional, forced, rollback and numerically ordered update contracts", () => {
  const r = { version: "4.10.0", update_mode: "OPTIONAL", sha256: "hash" };
  assert.equal(
    updateResponse(r, "4.6.5", "https://download").versionAction,
    "update",
  );
  assert.equal(updateResponse(r, "4.10.0", "x").updateAvailable, false);
  assert.equal(updateResponse(r, "5.0.0", "x").updateAvailable, false);
  assert.equal(
    updateResponse(
      { ...r, rollback: true, update_mode: "FORCED" },
      "5.0.0",
      "x",
    ).versionAction,
    "rollback",
  );
});
test("ZIP validates manifest version, required files and path safety", async () => {
  const pkg = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        manifest_version: 3,
        name: "GPT Yar",
        version: "4.6.6",
        background: { service_worker: "background.js" },
      }),
    ),
    "background.js": strToU8("// code"),
  });
  assert.equal((await inspectZip(pkg, "4.6.6")).manifest.version, "4.6.6");
  await assert.rejects(inspectZip(pkg, "4.6.7"), /MANIFEST_VERSION_MISMATCH/);
  const traversal = zipSync({ "../manifest.json": strToU8("{}") });
  await assert.rejects(inspectZip(traversal, "4.6.6"), /UNSAFE_ZIP_PATH/);
  const missing = zipSync({
    "manifest.json": strToU8(
      JSON.stringify({
        manifest_version: 3,
        name: "GPT Yar",
        version: "4.6.6",
        background: { service_worker: "missing.js" },
      }),
    ),
  });
  await assert.rejects(inspectZip(missing, "4.6.6"), /PACKAGE_MISSING_FILES/);
});
