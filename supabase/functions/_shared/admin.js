import { assert, compareVersions, AppError } from "./domain.js";
import { random, hash } from "./crypto.js";
import { authenticate, bodyJSON, readBytes } from "./context.js";
import { Bale } from "./clients.js";
import { inspectZip } from "./archive.js";
const id = (v) => {
  assert(/^[a-f0-9-]{36}$/.test(String(v)), "INVALID_ID");
  return v;
};
const integer = (v, min, max) => {
  assert(Number.isSafeInteger(v) && v >= min && v <= max, "INVALID_NUMBER");
  return v;
};
const date = (v) => {
  assert(
    typeof v === "string" && Number.isFinite(Date.parse(v)),
    "INVALID_DATE",
  );
  return new Date(v).toISOString();
};
const safeURL = (v) => {
  const u = new URL(v);
  assert(
    u.protocol === "https:" && !u.username && !u.password,
    "HTTPS_REQUIRED",
  );
  return u.href;
};
const text = (v, max = 1000) => {
  assert(typeof v === "string" && v.length <= max, "INVALID_TEXT");
  return v.trim();
};
export async function adminRoute(ctx, req, path) {
  if (path === "/api/login" && req.method === "POST") {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    await ctx.rate("login:" + ip, 8, 900);
    await ctx.rate("login:global", 80, 900);
    const b = await bodyJSON(req, 2048);
    await ctx.rate("login-token:" + (await hash(String(b.token))), 8, 900);
    const { profile } = await ctx.gpt.authorize(b.token);
    await ctx.scope(profile);
    const sessionToken = random(),
      sessionHash = await hash(sessionToken);
    const [session] = await ctx.db.insert("admin_sessions", {
      session_hash: sessionHash,
      account_id: String(profile.account.id),
      admin_fingerprint: await hash(b.token),
      token_ciphertext: await ctx.encrypt(
        b.token,
        "admin-session:" + sessionHash,
      ),
      expires_at: new Date(Date.now() + 8 * 3600000).toISOString(),
    });
    await ctx.audit(session.id, "login", String(profile.account.id));
    return { session: sessionToken, expiresAt: session.expires_at, profile };
  }
  if (path === "/api/logout" && req.method === "POST") {
    const bearer = req.headers.get("Authorization") || "";
    assert(/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer), "SESSION_REQUIRED", 401);
    const old = await ctx.db.one(
      "admin_sessions",
      `session_hash=eq.${await hash(bearer.slice(7))}`,
    );
    if (old) {
      await ctx.db.patch("admin_sessions", `id=eq.${old.id}`, {
        revoked_at: new Date().toISOString(),
        token_ciphertext: "",
      });
      await ctx.audit(old.id, "logout", old.account_id);
    }
    return { ok: true };
  }
  const auth = await authenticate(ctx, req),
    { session, token, profile } = auth;
  let b = {};
  if (!["GET", "HEAD"].includes(req.method)) {
    const key = req.headers.get("X-Request-ID");
    id(key);
    try {
      await ctx.db.insert("admin_requests", {
        session_id: session.id,
        request_id: key,
      });
    } catch (e) {
      if (e.dbCode === "23505")
        throw new AppError("REQUEST_ALREADY_RECEIVED", 409);
      throw e;
    }
    if (!path.endsWith("/releases/upload")) b = await bodyJSON(req);
    const target =
      typeof b.id === "string" && /^[a-f0-9-]{36}$/.test(b.id)
        ? b.id
        : ["day", "month"].includes(b.unit)
          ? b.unit
          : null;
    const auditPath = /^\/api\/[a-z/-]{1,80}$/.test(path)
      ? path
      : path.startsWith("/api/subscribers/")
        ? "/api/subscribers/:id"
        : "/api/invalid";
    await ctx.audit(session.id, `${req.method} ${auditPath}`, target, {
      request_id: key,
      phase: "requested",
    });
  }
  if (path === "/api/sessions/revoke" && req.method === "POST") {
    await ctx.db.patch(
      "admin_sessions",
      `account_id=eq.${session.account_id}&id=neq.${session.id}`,
      { revoked_at: new Date().toISOString() },
    );
    return { ok: true };
  }
  if (path === "/api/account" && req.method === "GET") return { profile };
  if (path === "/api/receipts" && req.method === "GET")
    return ctx.db.request(
      "payment_receipts?select=id,charge_id,payer_bale_id,status,order_id,error_code,created_at&status=eq.needs_review&order=created_at.desc&limit=100",
    );
  if (path === "/api/dashboard" && req.method === "GET")
    return {
      metrics: await ctx.db.rpc("metrics"),
      connections: {
        gptyar: { connected: true, checked_at: new Date().toISOString() },
        bot: await ctx.setting("bot"),
        wallet: await ctx.setting("wallet"),
      },
    };
  if (path === "/api/subscribers" && req.method === "GET")
    return ctx.gpt.list(token);
  if (path === "/api/subscribers" && req.method === "POST") {
    const name = text(b.name, 100);
    assert(name.length > 0, "INVALID_NAME");
    const expiresAt = b.expiresAt ? date(b.expiresAt) : undefined;
    // No automatic retry of an administrative create; request IDs prevent replays.
    try {
      return await ctx.gpt.create(token, name, expiresAt);
    } catch (e) {
      await ctx.event("MANUAL_CREATE_RESULT_REQUIRES_RECONCILIATION");
      throw e;
    }
  }
  const subscriber = /^\/api\/subscribers\/([^/]+)$/.exec(path);
  if (subscriber) {
    const subscriptionId = decodeURIComponent(subscriber[1]);
    assert(/^[\p{L}\p{N}_:-]{1,160}$/u.test(subscriptionId), "INVALID_ID");
    if (req.method === "PATCH")
      return ctx.gpt.update(token, subscriptionId, date(b.expiresAt));
    if (req.method === "DELETE")
      return ctx.gpt.call("/accupdator/subscribers/delete", "DELETE", token, {
        subscriptionId,
      });
  }
  if (path === "/api/cookies/status" && req.method === "GET")
    return ctx.gpt.call("/accupdator/fetch-cookies", "POST", token, { token });
  if (path === "/api/cookies" && req.method === "DELETE")
    return ctx.gpt.call("/accupdator/delete-cookies", "DELETE", token, {
      token,
    });
  if (path === "/api/cookies" && req.method === "POST") {
    assert(
      ["gpt", "grok", "claude", "midjourney"].includes(b.cookie_type) &&
        Array.isArray(b.cookies) &&
        b.cookies.length > 0 &&
        b.cookies.length <= 300,
      "INVALID_COOKIES",
    );
    const cookies = b.cookies.map((x) => {
      assert(
        x &&
          typeof x.name === "string" &&
          x.name.length <= 150 &&
          typeof x.value === "string" &&
          x.value.length <= 12000 &&
          typeof x.domain === "string" &&
          x.domain.length <= 250 &&
          typeof x.path === "string" &&
          x.path.length <= 250,
        "INVALID_COOKIES",
      );
      return {
        name: x.name,
        value: x.value,
        domain: x.domain,
        path: x.path,
        expirationDate: Number(x.expirationDate) || 0,
      };
    });
    return ctx.gpt.call("/accupdator/update-cookies", "POST", token, {
      token,
      cookie_type: b.cookie_type,
      cookies,
    });
  }
  if (path === "/api/proxies" && req.method === "GET")
    return ctx.gpt.call("/client/proxy-info", "POST", token, { token });
  if (path === "/api/settings" && req.method === "GET") {
    const data = await ctx.db.request("system_settings?select=key,value");
    const secrets = await ctx.db.request(
      "secure_settings?select=key,updated_at",
    );
    return {
      settings: Object.fromEntries(
        data
          .filter((x) => x.key !== "admin_notification_pair")
          .map((x) => [x.key, x.value]),
      ),
      secrets: secrets.map((x) => ({
        key: x.key,
        configured: true,
        revision: crypto.randomUUID(),
        updated_at: x.updated_at,
      })),
      extension_version: ctx.gpt.version,
      update_endpoint: `${ctx.env.SUPABASE_URL}/functions/v1/gptyar-api/public/check-for-update`,
    };
  }
  if (path === "/api/settings/notifications/pair" && req.method === "POST") {
    const secret = random();
    await ctx.set("admin_notification_pair", {
      hash: await hash(secret),
      expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
      session_id: session.id,
      used: false,
    });
    return { url: "https://ble.ir/gpryarbot?start=admin_" + secret };
  }
  if (path === "/api/settings/notifications/disable" && req.method === "POST") {
    await ctx.set("notifications", { enabled: false });
    return { ok: true };
  }
  if (path === "/api/settings/automation" && req.method === "POST") {
    if (b.revoke === true) {
      await ctx.db.request(
        "secure_settings?key=eq.gptyar_automation",
        "DELETE",
      );
      return { ok: true };
    }
    assert(b.consent === true, "EXPLICIT_STORAGE_CONSENT_REQUIRED");
    await ctx.saveSecret("gptyar_automation", token, session.id);
    await ctx.audit(
      session.id,
      "automation_storage_consent",
      profile.account.id,
    );
    return { ok: true };
  }
  if (path === "/api/settings/bot" && req.method === "POST") {
    assert(
      typeof b.token === "string" &&
        /^[0-9]+:[A-Za-z0-9_-]{20,200}$/.test(b.token),
      "INVALID_BOT_TOKEN",
    );
    const client = new Bale(b.token),
      me = await client.call("getMe");
    assert(
      me.is_bot && me.username?.toLowerCase() === "gpryarbot",
      "WRONG_BOT",
      409,
    );
    const secret = random(),
      webhook = `${ctx.env.SUPABASE_URL}/functions/v1/gptyar-api/bale/${secret}`;
    // Store before registration so incoming updates can be authenticated immediately.
    await ctx.saveSecret("bale_bot", b.token, session.id);
    await ctx.saveSecret("bale_webhook", secret, session.id);
    await ctx.set("bot", {
      enabled: false,
      connected: false,
      username: me.username,
      name: me.first_name,
      webhook_hash: await hash(secret),
      checked_at: new Date().toISOString(),
    });
    await client.call("setWebhook", { url: webhook });
    const info = await client.call("getWebhookInfo");
    assert(info.url === webhook, "WEBHOOK_NOT_CONFIRMED", 502);
    await ctx.set("bot", {
      enabled: false,
      connected: true,
      webhook_registered: true,
      username: me.username,
      name: me.first_name,
      webhook_hash: await hash(secret),
      checked_at: new Date().toISOString(),
    });
    return { ok: true, name: me.first_name, username: me.username };
  }
  if (path === "/api/settings/bot/check" && req.method === "POST") {
    const bot = await ctx.bot(),
      me = await bot.call("getMe"),
      info = await bot.call("getWebhookInfo"),
      secret = await ctx.secret("bale_webhook"),
      expected = `${ctx.env.SUPABASE_URL}/functions/v1/gptyar-api/bale/${secret}`;
    const state = await ctx.setting("bot");
    await ctx.set("bot", {
      ...state,
      connected: me.username?.toLowerCase() === "gpryarbot",
      webhook_registered: info.url === expected,
      checked_at: new Date().toISOString(),
    });
    return { ok: true, webhook_registered: info.url === expected };
  }
  if (path === "/api/settings/bot/toggle" && req.method === "POST") {
    const state = await ctx.setting("bot");
    assert(typeof b.enabled === "boolean", "INVALID_BOOLEAN");
    if (b.enabled) {
      const worker = await ctx.setting("worker");
      assert(
        Date.parse(worker.last_run_at) > Date.now() - 5 * 60000,
        "WORKER_NOT_RUNNING",
        409,
      );
      assert(
        state.connected && state.webhook_registered,
        "BOT_NOT_CONNECTED",
        409,
      );
      await ctx.secret("gptyar_automation");
    }
    await ctx.set("bot", { ...state, enabled: b.enabled });
    return { ok: true };
  }
  if (path === "/api/settings/wallet" && req.method === "POST") {
    assert(["live", "test"].includes(b.mode), "INVALID_PAYMENT_MODE");
    if (b.mode === "live") {
      assert(b.confirm === true, "LIVE_MODE_CONFIRMATION_REQUIRED");
      assert(
        typeof b.token === "string" &&
          b.token.length >= 10 &&
          b.token.length <= 300 &&
          b.token !== "WALLET-TEST-1111111111111111",
        "INVALID_PROVIDER_TOKEN",
      );
      await ctx.saveSecret("bale_provider", b.token, session.id);
    }
    // Provider has no documented introspection endpoint; saving is not verification.
    await ctx.set("wallet", {
      enabled: false,
      mode: b.mode,
      verified: false,
      test_verified: false,
      configured: true,
      revision: crypto.randomUUID(),
      updated_at: new Date().toISOString(),
    });
    return { ok: true, verified: false };
  }
  if (path === "/api/settings/wallet/toggle" && req.method === "POST") {
    const w = await ctx.setting("wallet");
    assert(typeof b.enabled === "boolean", "INVALID_BOOLEAN");
    assert(
      !b.enabled || w.mode === "test" || w.verified,
      "WALLET_NOT_VERIFIED",
      409,
    );
    await ctx.set("wallet", { ...w, enabled: b.enabled });
    return { ok: true };
  }
  if (path === "/api/settings/wallet/probe" && req.method === "POST") {
    const w = await ctx.setting("wallet");
    assert(
      w.configured && b.confirm === true,
      "PAYMENT_PROBE_CONFIRMATION_REQUIRED",
    );
    const user = String(b.bale_user_id);
    assert(/^[1-9]\d{0,15}$/.test(user), "INVALID_USER");
    await ctx.db.request(
      "bot_customers?on_conflict=bale_user_id",
      "POST",
      { bale_user_id: user },
      "resolution=ignore-duplicates,return=representation",
    );
    const c = await ctx.db.one("bot_customers", `bale_user_id=eq.${user}`);
    const [o] = await ctx.db.insert("orders", {
      customer_id: c.id,
      product_id: "chatgpt-plus-shared",
      purpose: "wallet_probe",
      intent: "purchase",
      unit: "day",
      quantity: 1,
      unit_price_rial: 1000,
      subtotal_rial: 1000,
      total_rial: 1000,
      mode: w.mode,
      wallet_revision: w.revision,
      invoice_expires_at: new Date(Date.now() + 20 * 60000).toISOString(),
    });
    const provider =
      w.mode === "test"
        ? "WALLET-TEST-1111111111111111"
        : await ctx.secret("bale_provider");
    const invoice = await (
      await ctx.bot()
    ).call("sendInvoice", {
      chat_id: user,
      title: "اعتبارسنجی کیف پول",
      description: `آزمایش اتصال کیف پول؛ ۱۰۰۰ ریال. اشتراک صادر نمی‌شود.${w.mode === "live" ? " این پرداخت واقعی است." : " انتقال وجه ندارد."}`,
      payload: o.id,
      provider_token: provider,
      prices: [{ label: "اعتبارسنجی اتصال", amount: 1000 }],
    });
    await ctx.db.patch("orders", `id=eq.${o.id}`, {
      invoice_message_id: String(invoice.message_id),
    });
    return { ok: true, order_id: o.id, amount_rial: 1000, mode: w.mode };
  }
  if (path === "/api/settings/limits" && req.method === "POST") {
    assert(b.confirmed === true, "LIMITS_REVIEW_REQUIRED");
    const maxUsers =
        b.maxUsers == null ? null : integer(b.maxUsers, 1, 1000000),
      maxDurationDays =
        b.maxDurationDays == null ? null : integer(b.maxDurationDays, 1, 36500);
    const value = {
      confirmed: true,
      maxUsers,
      maxDurationDays,
      maxExpiresAt: b.maxExpiresAt ? date(b.maxExpiresAt) : null,
      reviewed_at: new Date().toISOString(),
      account_id: session.account_id,
    };
    await ctx.set("limits", value);
    return { ok: true };
  }
  if (path === "/api/settings/support" && req.method === "POST") {
    await ctx.set("support", { url: safeURL(b.url), site: safeURL(b.site) });
    return { ok: true };
  }
  if (path === "/api/pricing" && req.method === "GET")
    return ctx.db.request("pricing_rules?order=unit");
  if (path === "/api/pricing" && req.method === "POST") {
    assert(
      ["day", "month"].includes(b.unit) && typeof b.enabled === "boolean",
      "INVALID_PRICING",
    );
    const min = integer(b.min_quantity, 1, 10000),
      max = integer(b.max_quantity, min, 10000),
      price = integer(b.unit_price_rial, 1, 100000000000);
    return ctx.db.patch(
      "pricing_rules",
      `product_id=eq.chatgpt-plus-shared&unit=eq.${b.unit}`,
      {
        enabled: b.enabled,
        min_quantity: min,
        max_quantity: max,
        unit_price_rial: price,
      },
    );
  }
  if (
    [
      "/api/orders",
      "/api/payments",
      "/api/renewals",
      "/api/claims",
      "/api/logs",
      "/api/events",
    ].includes(path) &&
    req.method === "GET"
  ) {
    const url = new URL(req.url),
      offset = Math.max(
        0,
        Math.min(100000, Number(url.searchParams.get("offset")) || 0),
      );
    if (path === "/api/claims")
      return ctx.db.request(
        `ownership_claims?select=id,customer_id,status,created_at,bot_customers(bale_user_id,first_name,last_name)&order=created_at.desc&limit=100&offset=${offset}`,
      );
    if (path === "/api/logs")
      return ctx.db.request(
        `audit_logs?order=created_at.desc&limit=100&offset=${offset}`,
      );
    if (path === "/api/events")
      return ctx.db.request(
        `system_events?order=created_at.desc&limit=100&offset=${offset}`,
      );
    if (path === "/api/payments")
      return ctx.db.request(
        `payments?order=created_at.desc&limit=100&offset=${offset}`,
      );
    let query = `orders?select=*,bot_customers(bale_user_id,first_name,last_name),payments(status,bale_charge_id,provider_charge_id),subscriptions(expires_at)&order=created_at.desc&limit=100&offset=${offset}`;
    if (path === "/api/renewals") query += "&intent=eq.renewal";
    const status = url.searchParams.get("status");
    if (status) {
      assert(/^[a-z_]{1,40}$/.test(status), "INVALID_STATUS");
      query += `&status=eq.${status}`;
    }
    const q = url.searchParams.get("q")?.trim();
    if (q) {
      assert(/^[\p{L}\p{N}\s_-]{1,80}$/u.test(q), "INVALID_SEARCH");
      if (/^[a-f0-9-]{36}$/.test(q)) query += `&id=eq.${q}`;
      else if (/^\d+$/.test(q)) {
        const c = await ctx.db.one("bot_customers", `bale_user_id=eq.${q}`);
        if (!c) return [];
        query += `&customer_id=eq.${c.id}`;
      } else
        query += `&or=(first_name.ilike.*${encodeURIComponent(q)}*,last_name.ilike.*${encodeURIComponent(q)}*)`;
    }
    return ctx.db.request(query);
  }
  if (path === "/api/orders/retry" && req.method === "POST") {
    const o = await ctx.db.one("orders", `id=eq.${id(b.id)}`);
    assert(o && o.status === "needs_review", "ORDER_NOT_REVIEWABLE", 409);
    const payment = await ctx.db.one("payments", `order_id=eq.${o.id}`);
    assert(payment, "PAYMENT_NOT_FOUND", 409);
    await ctx.enqueue(
      payment.status === "paid" ? "provision" : "verify_payment",
      o.id,
      "admin-retry:" + o.id + ":" + crypto.randomUUID(),
    );
    return {
      ok: true,
      message:
        "تطبیق امن در صف قرار گرفت؛ صدور نامشخص کورکورانه تکرار نمی‌شود.",
    };
  }
  if (path === "/api/orders/refund" && req.method === "POST") {
    const ref = text(b.reference, 200);
    assert(ref.length >= 4, "REFUND_REFERENCE_REQUIRED");
    const order = id(b.id);
    await ctx.db.rpc("record_refund", { p_order: order, p_reference: ref });
    return { ok: true };
  }
  if (path === "/api/claims/review" && req.method === "POST") {
    const claim = await ctx.db.one(
      "ownership_claims",
      `id=eq.${id(b.id)}&status=eq.pending`,
    );
    assert(claim, "CLAIM_NOT_FOUND", 404);
    if (b.approve === true) {
      assert(b.ownership_verified === true, "OWNERSHIP_EVIDENCE_REQUIRED");
      const secret = await ctx.decrypt(
        claim.token_ciphertext,
        "ownership:" + claim.token_fingerprint,
      );
      const remote = (await ctx.gpt.list(token)).subscribers.find(
        (x) => x.token === secret,
      );
      assert(remote?.expiresAt, "SUBSCRIPTION_NOT_FOUND", 409);
      await ctx.db.rpc("attach_claim", {
        p_claim: claim.id,
        p_remote: remote.subscriptionId,
        p_account: session.account_id,
        p_ciphertext: await ctx.encrypt(
          secret,
          "subscription:" + remote.subscriptionId,
        ),
        p_name: remote.name,
        p_expiry: remote.expiresAt,
      });
    }
    if (b.approve !== true)
      await ctx.db.patch("ownership_claims", `id=eq.${claim.id}`, {
        status: "rejected",
      });
    return { ok: true };
  }
  if (path === "/api/discounts" && req.method === "GET")
    return ctx.db.request("discount_codes?order=created_at.desc");
  if (path === "/api/discounts" && req.method === "POST") {
    const d = {
      code: text(b.code, 40).toUpperCase(),
      kind: b.kind,
      value: integer(b.value, 1, 100000000000),
      scope: b.scope,
      starts_at: date(b.starts_at),
      ends_at: b.ends_at ? date(b.ends_at) : null,
      max_uses: b.max_uses == null ? null : integer(b.max_uses, 1, 10000000),
      per_customer: integer(b.per_customer, 1, 100000),
      active: b.active === true,
      archived: b.archived === true,
    };
    assert(
      /^[A-Z0-9_-]{3,40}$/.test(d.code) &&
        ["percent", "fixed"].includes(d.kind) &&
        ["both", "purchase", "renewal"].includes(d.scope) &&
        (d.kind !== "percent" || d.value <= 100),
      "INVALID_DISCOUNT",
    );
    if (b.id) return ctx.db.patch("discount_codes", `id=eq.${id(b.id)}`, d);
    return ctx.db.insert("discount_codes", d);
  }
  if (path === "/api/videos" && req.method === "GET")
    return ctx.db.request("educational_videos?order=sort_order");
  if (path === "/api/uploads" && req.method === "POST") {
    assert(["video", "poster"].includes(b.kind), "INVALID_UPLOAD_TYPE");
    const bucket = b.kind === "video" ? "gptyar-videos" : "gptyar-posters";
    const types =
      b.kind === "video"
        ? { "video/mp4": ".mp4", "video/webm": ".webm" }
        : { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
    assert(Object.hasOwn(types, b.mime), "INVALID_MIME");
    integer(
      b.size,
      1,
      b.kind === "video" ? 500 * 1024 * 1024 : 5 * 1024 * 1024,
    );
    const path = crypto.randomUUID() + types[b.mime];
    const [ticket] = await ctx.db.insert("upload_tickets", {
      bucket,
      path,
      mime: b.mime,
      session_id: session.id,
      expires_at: new Date(Date.now() + 2 * 3600000).toISOString(),
    });
    const signed = await (
      await ctx.storage(`object/upload/sign/${bucket}/${path}`, "POST", {})
    ).json();
    return {
      ticket: ticket.id,
      path,
      url:
        ctx.env.SUPABASE_URL + "/storage/v1" + (signed.url || signed.signedURL),
      mime: b.mime,
    };
  }
  if (path === "/api/videos" && req.method === "POST") {
    const d = {
      slug: text(b.slug, 40),
      title: text(b.title, 150),
      description: text(b.description || "", 3000),
      sort_order: integer(b.sort_order, 0, 1000),
      active: b.active === true,
    };
    assert(/^[a-z][a-z0-9-]{1,39}$/.test(d.slug), "INVALID_SLUG");
    for (const [field, kind] of [
      ["storage_path", "video"],
      ["poster_path", "poster"],
    ])
      if (b[field]) {
        const bucket = kind === "video" ? "gptyar-videos" : "gptyar-posters",
          ticket = await ctx.db.one(
            "upload_tickets",
            `path=eq.${encodeURIComponent(b[field])}&bucket=eq.${bucket}&session_id=eq.${session.id}&expires_at=gt.${new Date().toISOString()}`,
          );
        const current = b.id
          ? await ctx.db.one("educational_videos", `id=eq.${id(b.id)}`)
          : null;
        assert(
          ticket || current?.[field] === b[field],
          "UPLOAD_NOT_AUTHORIZED",
          403,
        );
        if (ticket) {
          const info = await ctx.storage(
            `object/info/${bucket}/${b[field]}`,
            "GET",
          );
          assert(info.ok, "UPLOAD_NOT_FOUND");
          await ctx.db.patch("upload_tickets", `id=eq.${ticket.id}`, {
            used_at: new Date().toISOString(),
          });
        }
        d[field] = b[field];
      }
    const existing = b.id
      ? await ctx.db.one("educational_videos", `id=eq.${id(b.id)}`)
      : null;
    assert(
      !d.active || d.storage_path || existing?.storage_path,
      "VIDEO_FILE_REQUIRED",
    );
    return b.id
      ? ctx.db.patch("educational_videos", `id=eq.${id(b.id)}`, d)
      : ctx.db.insert("educational_videos", d);
  }
  if (path === "/api/releases" && req.method === "GET")
    return ctx.db.request("extension_versions?order=created_at.desc");
  if (path === "/api/releases/upload" && req.method === "POST") {
    const u = new URL(req.url),
      version = text(u.searchParams.get("version"), 30);
    compareVersions(version, version);
    assert(
      req.headers.get("Content-Type") === "application/zip",
      "ZIP_REQUIRED",
      415,
    );
    assert(
      Number(req.headers.get("Content-Length") || 0) <= 20 * 1024 * 1024,
      "BODY_TOO_LARGE",
      413,
    );
    const bytes = await readBytes(req, 20 * 1024 * 1024);
    const pkg = await inspectZip(bytes, version),
      digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
    const storagePath = `${version}/${digest}.zip`;
    await ctx.storage(`object/gptyar-releases/${storagePath}`, "POST", bytes);
    return ctx.db.insert("extension_versions", {
      version,
      storage_path: storagePath,
      sha256: digest,
      size_bytes: bytes.length,
      manifest: pkg.manifest,
      update_endpoint: pkg.updateEndpoint,
    });
  }
  if (path === "/api/releases" && req.method === "POST") {
    const release = await ctx.db.one("extension_versions", `id=eq.${id(b.id)}`);
    assert(release, "VERSION_NOT_FOUND", 404);
    if (b.download_link)
      await verifyDownload(ctx, safeURL(b.download_link), release);
    assert(
      ["OPTIONAL", "FORCED"].includes(b.update_mode),
      "INVALID_UPDATE_MODE",
    );
    return ctx.db.patch("extension_versions", `id=eq.${id(b.id)}`, {
      changelog: text(b.changelog, 10000),
      update_mode: b.update_mode,
      download_link: b.download_link ? safeURL(b.download_link) : null,
    });
  }
  if (path === "/api/releases/publish" && req.method === "POST") {
    const release = await ctx.db.one("extension_versions", `id=eq.${id(b.id)}`);
    assert(release, "VERSION_NOT_FOUND", 404);
    assert(
      release.update_endpoint ===
        ctx.env.SUPABASE_URL +
          "/functions/v1/gptyar-api/public/check-for-update",
      "RELEASE_CHANNEL_NOT_CONNECTED",
      409,
    );
    if (release.download_link)
      await verifyDownload(ctx, release.download_link, release);
    await ctx.db.rpc("publish", {
      p_id: id(b.id),
      p_rollback: b.rollback === true,
    });
    return { ok: true };
  }
  throw new AppError("NOT_FOUND", 404);
}

async function verifyDownload(ctx, link, release) {
  const allowed = String(
    ctx.env.RELEASE_DOWNLOAD_HOSTS || new URL(ctx.env.SUPABASE_URL).hostname,
  )
    .split(",")
    .map((x) => x.trim());
  assert(
    allowed.includes(new URL(link).hostname),
    "EXTERNAL_DOWNLOAD_HOST_NOT_ALLOWED",
  );
  const r = await fetch(link, {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  assert(r.ok, "DOWNLOAD_NOT_VERIFIED");
  const bytes = await readBytes(r, 20 * 1024 * 1024),
    digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  assert(
    digest === release.sha256 && bytes.length === Number(release.size_bytes),
    "DOWNLOAD_HASH_MISMATCH",
  );
}
