/* Local integration: real PostgreSQL/WASM and production handlers; external GPT Yar/Bale responses are explicit fixtures. No network or real issuance/payment. */
import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHandler } from "../supabase/functions/_shared/handler.js";
import { context } from "../supabase/functions/_shared/context.js";
import {
  processUpdate,
  preCheckout,
} from "../supabase/functions/_shared/bot.js";
import { runJobs, provision } from "../supabase/functions/_shared/worker.js";
import { hash } from "../supabase/functions/_shared/crypto.js";
const env = {
  SUPABASE_URL: "https://fixture.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service-key",
  GPTYAR_ACCOUNT_ID: "account-fixture",
  GPTYAR_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
  ADMIN_ORIGINS: "https://admin.example",
  GPTYAR_WORKER_SECRET: "fixture-worker",
};
const fixtureToken = "@fixture-admin-token",
  remote = [],
  invoices = [],
  sent = [],
  methods = [];
let hook = "",
  createCount = 0,
  unknownCreate = false,
  updateId = 10,
  db;
const sql = async (s, p = []) => (await db.query(s, p)).rows;
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const jsonValue = (v) => (v && typeof v === "object" ? JSON.stringify(v) : v);
const names = (s) => {
  assert(/^[a-z_]+$/.test(s));
  return s;
};
async function rest(u, o) {
  const table = u.pathname.split("/rest/v1/")[1],
    method = o.method || "GET",
    b = o.body ? JSON.parse(o.body) : null;
  if (table.startsWith("rpc/")) {
    const name = names(table.slice(4)),
      keys = Object.keys(b || {}),
      params = keys.map((k) => b[k]);
    const call = `${name}(${keys.map((k, i) => names(k) + "=> $" + (i + 1)).join(",")})`;
    return response(
      name === "gy_claim_job"
        ? await sql(`select * from ${call}`, params)
        : (await sql(`select to_jsonb(${call}) result`, params))[0].result,
    );
  }
  names(table);
  const params = [],
    clauses = [];
  for (const [k, v] of u.searchParams) {
    if (["select", "order", "limit", "offset", "on_conflict"].includes(k))
      continue;
    names(k);
    const dot = v.indexOf("."),
      op = v.slice(0, dot),
      value = v.slice(dot + 1);
    let condition;
    if (op === "is") {
      condition = value === "null" ? `${k} is null` : `${k} is not null`;
    } else if (op === "not" && value === "is.null")
      condition = `${k} is not null`;
    else if (op === "in") {
      const choices = value.slice(1, -1).split(",");
      condition = `${k} in (${choices
        .map((x) => {
          params.push(x);
          return "$" + params.length;
        })
        .join(",")})`;
    } else {
      const symbol = {
        eq: "=",
        neq: "<>",
        gt: ">",
        lt: "<",
        gte: ">=",
        lte: "<=",
      }[op];
      assert(symbol, "unsupported fixture filter " + op);
      params.push(value);
      condition = `${k} ${symbol} $${params.length}`;
    }
    clauses.push(condition);
  }
  const where = clauses.length ? " where " + clauses.join(" and ") : "";
  if (method === "GET") {
    let suffix = "";
    const order = u.searchParams.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      suffix += " order by " + names(col) + (dir === "desc" ? " desc" : " asc");
    }
    const limit = u.searchParams.get("limit");
    if (limit) suffix += " limit " + Number(limit);
    const offset = u.searchParams.get("offset");
    if (offset) suffix += " offset " + Number(offset);
    return response(
      await sql(`select * from ${table}${where}${suffix}`, params),
    );
  }
  if (method === "POST") {
    const keys = Object.keys(b).map(names);
    let stmt = `insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`;
    if (o.headers.Prefer?.includes("resolution=")) {
      const conflict = (
        u.searchParams.get("on_conflict") ||
        {
          system_settings: "key",
          secure_settings: "key",
          bot_conversations: "customer_id",
        }[table] ||
        "id"
      )
        .split(",")
        .map(names)
        .join(",");
      stmt +=
        ` on conflict (${conflict}) do ` +
        (o.headers.Prefer.includes("ignore-duplicates")
          ? "nothing"
          : `update set ${keys.map((k) => `${k}=excluded.${k}`).join(",")}`);
    }
    return response(
      await sql(
        stmt + " returning *",
        keys.map((k) => jsonValue(b[k])),
      ),
    );
  }
  if (method === "PATCH") {
    const keys = Object.keys(b).map(names),
      values = keys.map((k) => jsonValue(b[k]));
    const shifted = where.replace(
      /\$(\d+)/g,
      (_, n) => "$" + (Number(n) + keys.length),
    );
    return response(
      await sql(
        `update ${table} set ${keys.map((k, i) => k + "=$" + (i + 1)).join(",")}${shifted} returning *`,
        [...values, ...params],
      ),
    );
  }
  if (method === "DELETE")
    return response(
      await sql(`delete from ${table}${where} returning *`, params),
    );
  throw Error("unsupported fixture method");
}
async function fixtureFetch(url, o = {}) {
  const u = new URL(url);
  try {
    if (u.origin === env.SUPABASE_URL) return await rest(u, o);
    if (u.origin === "https://api.gptyar.com") {
      if (o.headers.Authorization !== "Bearer " + fixtureToken)
        return response({ error: "invalid" }, 403);
      const b = o.body ? JSON.parse(o.body) : {};
      if (u.pathname === "/accupdator/validate")
        return response({
          message: "authorized",
          account: {
            id: env.GPTYAR_ACCOUNT_ID,
            type: "ENTERPRISE",
            limits: { maxUsers: 50, maxDurationDays: 120 },
          },
          agent: { name: "fixture" },
        });
      if (u.pathname.endsWith("/all"))
        return response({
          accountId: env.GPTYAR_ACCOUNT_ID,
          accountType: "ENTERPRISE",
          limits: { maxUsers: 50, maxDurationDays: 120 },
          subscribers: remote,
        });
      if (u.pathname.endsWith("/create")) {
        createCount++;
        const s = {
          subscriptionId: "remote-" + createCount,
          name: b.name,
          token: "subscriber-fixture-" + createCount,
          expiresAt: b.expiresAt,
          isActive: true,
        };
        remote.push(s);
        if (unknownCreate) {
          unknownCreate = false;
          throw Error("fixture network lost after upstream mutation");
        }
        return response(s);
      }
      if (u.pathname.endsWith("/update")) {
        const s = remote.find((s) => s.subscriptionId === b.subscriptionId);
        s.expiresAt = b.expiresAt;
        return response({ ok: true });
      }
    }
    if (u.origin === "https://tapi.bale.ai") {
      const method = u.pathname.split("/").at(-1),
        b = JSON.parse(o.body);
      methods.push({ method, body: b });
      if (method === "getMe")
        return response({
          ok: true,
          result: {
            id: 1,
            is_bot: true,
            username: "gpryarbot",
            first_name: "GPT Yar",
          },
        });
      if (method === "setWebhook") {
        hook = b.url;
        return response({ ok: true, result: true });
      }
      if (method === "getWebhookInfo")
        return response({ ok: true, result: { url: hook } });
      if (method === "sendInvoice") {
        invoices.push(b);
        return response({ ok: true, result: { message_id: invoices.length } });
      }
      if (method === "sendMessage") {
        sent.push(b);
        return response({ ok: true, result: { message_id: sent.length } });
      }
      if (method === "answerPreCheckoutQuery")
        return response({ ok: true, result: true });
      if (method === "inquireTransaction") {
        const p = (
          await sql("select * from payments where bale_charge_id=$1", [
            b.transaction_id,
          ])
        )[0];
        return response({
          ok: true,
          result: {
            id: b.transaction_id,
            status: "paid",
            userID: Number(p.payer_bale_id),
            amount: Number(p.amount_rial),
          },
        });
      }
    }
    throw Error("unhandled fixture URL " + u.origin + u.pathname);
  } catch (e) {
    if (u.origin === env.SUPABASE_URL)
      return response({ message: e.message, code: e.code }, 400);
    throw e;
  }
}
test("local integration: secure login, bot setup, invoices, payment verification, issuance, renewal and recovery", async (t) => {
  db = new PGlite();
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20261018080907_gptyar_commerce.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const original = globalThis.fetch;
  globalThis.fetch = fixtureFetch;
  t.after(async () => {
    globalThis.fetch = original;
    await db.close();
  });
  const ctx = context(env),
    handle = createHandler(env);
  let session;
  const api = async (
    path,
    body,
    token = session,
    requestId = crypto.randomUUID(),
  ) => {
    const res = await handle(
      new Request(env.SUPABASE_URL + "/functions/v1/gptyar-api" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Origin: "https://admin.example",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(body
            ? { "Content-Type": "application/json", "X-Request-ID": requestId }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  const userMessage = async (text, user = 123) =>
    processUpdate(ctx, {
      update_id: ++updateId,
      message: {
        from: { id: user, is_bot: false },
        chat: { id: user, type: "private" },
        text,
      },
    });
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await sql(
        "update outbox_jobs set available_at=now() where state='pending'",
      );
      await runJobs(ctx, 8);
    }
  };
  await t.test(
    "invalid and ordinary tokens denied; valid management token creates opaque revocable session",
    async () => {
      assert.equal(
        (await api("/api/login", { token: "ordinary" }, null)).status,
        401,
      );
      assert.equal(
        (await api("/api/login", { token: "@invalid" }, null)).status,
        401,
      );
      const login = await api("/api/login", { token: fixtureToken }, null);
      assert.equal(login.status, 200);
      session = login.body.session;
      assert.match(session, /^[\w-]{43}$/);
      assert(!JSON.stringify(login.body).includes(fixtureToken));
      const row = (await sql("select * from admin_sessions"))[0];
      assert(!row.token_ciphertext.includes(fixtureToken));
      assert.equal(row.session_hash, await hash(session));
    },
  );
  await t.test(
    "automatic token storage needs explicit consent; admin replay is rejected",
    async () => {
      assert.equal(
        (await api("/api/settings/automation", { consent: false })).status,
        400,
      );
      assert.equal(
        (await api("/api/settings/automation", { consent: true })).status,
        200,
      );
      const key = crypto.randomUUID();
      assert.equal(
        (
          await api(
            "/api/settings/limits",
            { confirmed: true, maxUsers: 50, maxDurationDays: 120 },
            session,
            key,
          )
        ).status,
        200,
      );
      assert.equal(
        (await api("/api/settings/limits", { confirmed: true }, session, key))
          .status,
        409,
      );
    },
  );
  await t.test(
    "bot token registration validates identity and webhook without exposing token",
    async () => {
      const token = "123456:" + "a".repeat(30);
      assert.equal((await api("/api/settings/bot", { token })).status, 200);
      assert.match(hook, /\/bale\/[A-Za-z0-9_-]{43}$/);
      const settings = await api("/api/settings");
      assert(!JSON.stringify(settings.body).includes(token));
      await runJobs(ctx);
      assert.equal(
        (await api("/api/settings/bot/toggle", { enabled: true })).status,
        200,
      );
    },
  );
  await t.test(
    "admin notices pair with a single-use private-chat capability",
    async () => {
      const pair = await api("/api/settings/notifications/pair", {});
      assert.equal(pair.status, 200);
      const secret = new URL(pair.body.url).searchParams.get("start");
      await userMessage("/start " + secret, 777);
      assert.equal((await ctx.setting("notifications")).bale_user_id, "777");
      await userMessage("/start " + secret, 999);
      assert.equal((await ctx.setting("notifications")).bale_user_id, "777");
    },
  );
  await t.test(
    "saving a live wallet never marks it verified or enables real sales",
    async () => {
      assert.equal(
        (
          await api("/api/settings/wallet", {
            mode: "live",
            token: "fixture-provider-token",
            confirm: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (await api("/api/settings/wallet/toggle", { enabled: true })).status,
        409,
      );
    },
  );
  await t.test(
    "official wallet probe needs an actual matched receipt plus paid inquiry; never issues a subscriber",
    async () => {
      const probe = await api("/api/settings/wallet/probe", {
        bale_user_id: "123",
        confirm: true,
      });
      assert.equal(probe.status, 200);
      const order = (
        await sql("select * from orders where id=$1", [probe.body.order_id])
      )[0];
      await preCheckout(ctx, {
        id: "probe-charge",
        from: { id: 123 },
        currency: "IRR",
        total_amount: 1000,
        invoice_payload: order.id,
      });
      assert.equal(methods.at(-1).body.ok, true);
      assert.equal(createCount, 0);
      const receipt = {
        currency: "IRR",
        total_amount: 1000,
        invoice_payload: order.id,
        telegram_payment_charge_id: "probe-charge",
        provider_payment_charge_id: "probe-provider",
      };
      await processUpdate(ctx, {
        update_id: ++updateId,
        message: {
          from: { id: 123 },
          chat: { id: 123, type: "private" },
          successful_payment: receipt,
        },
      });
      await flush();
      assert.equal(createCount, 0);
      assert.equal((await ctx.setting("wallet")).verified, true);
      assert.equal(
        (await sql("select status from orders where id=$1", [order.id]))[0]
          .status,
        "completed",
      );
      assert.equal((await ctx.db.rpc("metrics")).sales, 0);
      await api("/api/settings/wallet/toggle", { enabled: true });
    },
  );
  let bought;
  await t.test(
    "Persian purchase flow calculates amount; payment precedes names and true API fixture token",
    async () => {
      for (const text of [
        "/start",
        "خرید حساب اشتراکی",
        "روزانه",
        "۲",
        "پرداخت",
      ])
        await userMessage(text);
      const invoice = invoices.at(-1);
      assert.equal(invoice.prices[0].amount, 700000);
      bought = (
        await sql("select * from orders where id=$1", [invoice.payload])
      )[0];
      const payment = {
        currency: "IRR",
        total_amount: 700000,
        invoice_payload: bought.id,
        telegram_payment_charge_id: "sale-charge",
        provider_payment_charge_id: "sale-provider",
      };
      await preCheckout(ctx, {
        id: "sale-charge",
        from: { id: 999 },
        currency: "IRR",
        total_amount: 700000,
        invoice_payload: bought.id,
      });
      assert.equal(methods.at(-1).body.ok, false);
      await preCheckout(ctx, {
        id: "sale-charge",
        from: { id: 123 },
        currency: "IRR",
        total_amount: 700000,
        invoice_payload: bought.id,
      });
      assert.equal(methods.at(-1).body.ok, true);
      assert.equal(createCount, 0);
      await processUpdate(ctx, {
        update_id: ++updateId,
        message: {
          from: { id: 123 },
          chat: { id: 123, type: "private" },
          successful_payment: payment,
        },
      });
      await flush();
      assert.equal(createCount, 0);
      assert.equal(
        (await sql("select status from orders where id=$1", [bought.id]))[0]
          .status,
        "awaiting_customer_details",
      );
      await userMessage("علی");
      await userMessage("محمدی");
      await flush();
      assert.equal(createCount, 1);
      assert.equal(
        (await sql("select status from orders where id=$1", [bought.id]))[0]
          .status,
        "completed",
      );
      const s = (await sql("select * from subscriptions"))[0];
      assert(!s.token_ciphertext.includes("subscriber-fixture-1"));
      assert(
        sent.some(
          (m) => m.chat_id === "123" && m.text.includes("subscriber-fixture-1"),
        ),
      );
      assert(!sent.some((m) => m.text.includes(fixtureToken)));
      await processUpdate(ctx, {
        update_id: ++updateId,
        message: {
          from: { id: 123 },
          chat: { id: 123, type: "private" },
          successful_payment: payment,
        },
      });
      await flush();
      assert.equal(createCount, 1);
    },
  );
  await t.test(
    "renewal keeps the same token and all remaining validity",
    async () => {
      const previous = remote[0].expiresAt;
      for (const text of ["تمدید اشتراک", "۱", "روزانه", "۳", "پرداخت"])
        await userMessage(text);
      const invoice = invoices.at(-1),
        payment = {
          currency: "IRR",
          total_amount: 1050000,
          invoice_payload: invoice.payload,
          telegram_payment_charge_id: "renew-charge",
          provider_payment_charge_id: "renew-provider",
        };
      await processUpdate(ctx, {
        update_id: ++updateId,
        message: {
          from: { id: 123 },
          chat: { id: 123, type: "private" },
          successful_payment: payment,
        },
      });
      await flush();
      assert.equal(createCount, 1);
      assert.equal(
        Date.parse(remote[0].expiresAt) - Date.parse(previous),
        3 * 86400000,
      );
      assert.equal(remote[0].token, "subscriber-fixture-1");
    },
  );
  await t.test(
    "uncertain upstream result reconciles by unique marker without issuing a second account",
    async () => {
      const c = (
        await sql("select id from bot_customers where bale_user_id=123")
      )[0].id;
      const o = (
        await sql(
          "select to_jsonb(gy_new_order($1,'purchase','day',1,'live')) o",
          [c],
        )
      )[0].o;
      await sql(
        "select gy_record_payment($1,123,350000,'IRR','uncertain','uncertain-provider',true)",
        [o.id],
      );
      await sql("select gy_customer_details($1,$2,'رضا','احمدی')", [o.id, c]);
      unknownCreate = true;
      await provision(ctx, o.id);
      assert.equal(createCount, 2);
      assert.equal(
        (await sql("select status from orders where id=$1", [o.id]))[0].status,
        "needs_review",
      );
      await provision(ctx, o.id);
      assert.equal(createCount, 2);
      assert.equal(
        (await sql("select status from orders where id=$1", [o.id]))[0].status,
        "completed",
      );
    },
  );
  await t.test(
    "foreign customer cannot view/renew another customer subscription; suspicious receipts remain traceable",
    async () => {
      await userMessage("تمدید اشتراک", 999);
      assert(sent.at(-1).text.includes("اشتراکی برای شما ثبت نشده"));
      await processUpdate(ctx, {
        update_id: ++updateId,
        message: {
          from: { id: 999 },
          chat: { id: 123, type: "private" },
          text: "اشتراک‌های من",
        },
      });
      assert(!sent.at(-1).text.includes("subscriber-fixture"));
      await assert.rejects(
        processUpdate(ctx, {
          update_id: ++updateId,
          message: {
            from: { id: 999 },
            chat: { id: 999, type: "private" },
            successful_payment: {
              currency: "IRR",
              total_amount: 700000,
              invoice_payload: bought.id,
              telegram_payment_charge_id: "suspicious",
              provider_payment_charge_id: "suspicious-p",
            },
          },
        }),
        /NOT_OWNER/,
      );
      assert.equal(
        (
          await sql(
            "select status from payment_receipts where charge_id='suspicious'",
          )
        )[0].status,
        "needs_review",
      );
    },
  );
  await t.test(
    "official sandbox completes purchase details without issuing a real upstream account",
    async () => {
      const before = createCount,
        revenue = (await ctx.db.rpc("metrics")).sales;
      assert.equal(
        (await api("/api/settings/wallet", { mode: "test" })).status,
        200,
      );
      await api("/api/settings/wallet/toggle", { enabled: true });
      for (const text of [
        "/start",
        "خرید حساب اشتراکی",
        "روزانه",
        "۱",
        "پرداخت",
      ])
        await userMessage(text, 234);
      const invoice = invoices.at(-1);
      assert.equal(invoice.provider_token, "WALLET-TEST-1111111111111111");
      await processUpdate(ctx, {
        update_id: ++updateId,
        message: {
          from: { id: 234 },
          chat: { id: 234, type: "private" },
          successful_payment: {
            currency: "IRR",
            total_amount: 350000,
            invoice_payload: invoice.payload,
            telegram_payment_charge_id: "sandbox-charge",
            provider_payment_charge_id: "sandbox-provider",
          },
        },
      });
      await flush();
      await userMessage("کاربر", 234);
      await userMessage("آزمایشی", 234);
      await flush();
      assert.equal(createCount, before);
      assert.equal((await ctx.db.rpc("metrics")).sales, revenue);
      assert(
        sent.some(
          (m) => m.chat_id === "234" && m.text.includes("توکن واقعی صادر نشده"),
        ),
      );
    },
  );
  await t.test(
    "logout revokes server session and all later requests fail",
    async () => {
      assert.equal((await api("/api/logout", {})).status, 200);
      assert.equal((await api("/api/account")).status, 401);
    },
  );
});
