import { bodyJSON, context } from "./context.js";
import { adminRoute } from "./admin.js";
import { AppError, assert, updateResponse } from "./domain.js";
import { equalHash, hash } from "./crypto.js";
import { preCheckout } from "./bot.js";
import { runJobs } from "./worker.js";
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
};
export function createHandler(env, waitUntil = (_promise) => {}) {
  const ctx = context(env),
    adminOrigins = String(env.ADMIN_ORIGINS || "https://gptyar-web.github.io")
      .split(",")
      .map((x) => x.trim()),
    publicOrigins = String(env.PUBLIC_ORIGINS || "https://gptyar-web.github.io")
      .split(",")
      .map((x) => x.trim());
  return async (req) => {
    const u = new URL(req.url),
      path = u.pathname
        .replace(/^\/functions\/v1\/gptyar-api/, "")
        .replace(/^\/gptyar-api/, "") || "/",
      origin = req.headers.get("Origin");
    const isPublic = path.startsWith("/public/"),
      allowed = (isPublic ? publicOrigins : adminOrigins).includes(origin);
    const cors = origin && allowed
      ? {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Request-ID",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Max-Age": "300",
      }
      : {};
    const json = (d, s = 200) =>
      new Response(JSON.stringify(d), {
        status: s,
        headers: { ...HEADERS, ...cors },
      });
    try {
      if (req.method === "OPTIONS") {
        assert(allowed, "ORIGIN_NOT_ALLOWED", 403);
        return new Response(null, {
          status: 204,
          headers: { ...HEADERS, ...cors },
        });
      }
      assert(
        u.protocol === "https:" ||
          // Supabase terminates public TLS at its gateway; the hosted runtime
          // may receive an internal HTTP URL. Trust only its runtime marker,
          // never a caller-supplied forwarded-protocol header.
          (u.protocol === "http:" && Boolean(env.DENO_DEPLOYMENT_ID) &&
            /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(
              env.SUPABASE_URL || "",
            )) ||
          env.LOCAL_DEVELOPMENT === "true",
        "HTTPS_REQUIRED",
        400,
      );
      if (path.startsWith("/api/")) {
        assert(
          origin && adminOrigins.includes(origin),
          "ORIGIN_NOT_ALLOWED",
          403,
        );
        return json(await adminRoute(ctx, req, path));
      }
      if (path === "/health" && req.method === "GET") {
        return json({
          ok: true,
          service: "GPT Yar API",
          version: "3.0.0",
          security_configured: Boolean(
            env.GPTYAR_ACCOUNT_ID && env.GPTYAR_ENCRYPTION_KEY,
          ),
          worker_configured: Boolean(env.GPTYAR_WORKER_SECRET),
        });
      }
      if (path === "/jobs/run" && req.method === "POST") {
        assert(
          env.GPTYAR_WORKER_SECRET &&
            (await equalHash(
              req.headers.get("Authorization"),
              "Bearer " + env.GPTYAR_WORKER_SECRET,
            )),
          "WORKER_UNAUTHORIZED",
          401,
        );
        return json(await runJobs(ctx));
      }
      if (path.startsWith("/bale/") && req.method === "POST") {
        const capability = path.slice(6);
        assert(
          /^[A-Za-z0-9_-]{43}$/.test(capability),
          "WEBHOOK_UNAUTHORIZED",
          401,
        );
        const state = await context(env, { dbTimeout: 700 }).setting("bot");
        assert(
          (await hash(capability)) === state.webhook_hash,
          "WEBHOOK_UNAUTHORIZED",
          401,
        );
        const body = await bodyJSON(req, 100000);
        assert(
          Number.isSafeInteger(body.update_id) && body.update_id >= 0,
          "INVALID_UPDATE",
        );
        if (body.pre_checkout_query) {
          await preCheckout(
            context(env, { dbTimeout: 700 }),
            body.pre_checkout_query,
          );
          return json({ ok: true });
        }
        const ciphertext = await ctx.encrypt(
          JSON.stringify(body),
          "update:" + body.update_id,
        );
        await ctx.db.rpc("ingest_update", {
          p_id: body.update_id,
          p_ciphertext: ciphertext,
        });
        // Background work is only a latency optimization. pg_cron resumes committed jobs after any crash.
        waitUntil(runJobs(ctx).catch(() => {}));
        return json({ ok: true });
      }
      if (isPublic) {
        assert(
          !origin || allowed || origin.startsWith("chrome-extension://"),
          "ORIGIN_NOT_ALLOWED",
          403,
        );
        await ctx.rate(
          "public:" +
            (req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown"),
          120,
          60,
        );
        if (path === "/public/catalog" && req.method === "GET") {
          const pricing = await ctx.db.request(
            "pricing_rules?select=unit,unit_price_rial,enabled,min_quantity,max_quantity&product_id=eq.chatgpt-plus-shared",
          );
          const raw = await ctx.db.request(
            "educational_videos?active=eq.true&storage_path=not.is.null&order=sort_order",
          );
          const videos = await Promise.all(
            raw.map(async (v) => ({
              id: v.id,
              slug: v.slug,
              title: v.title,
              description: v.description,
              sort_order: v.sort_order,
              url: await ctx.sign("gptyar-videos", v.storage_path),
              poster: v.poster_path
                ? await ctx.sign("gptyar-posters", v.poster_path)
                : null,
            })),
          );
          const bot = await ctx.setting("bot"),
            wallet = await ctx.setting("wallet");
          return json({
            product: "chatgpt-plus-shared",
            currency: "IRR",
            month_days: 30,
            pricing,
            videos,
            purchase_url: "https://ble.ir/gpryarbot",
            sales_enabled: bot.enabled &&
              wallet.enabled &&
              (wallet.mode === "test" || wallet.verified),
            mode: wallet.mode,
          });
        }
        if (path === "/public/check-for-update" && req.method === "POST") {
          const b = await bodyJSON(req, 4096);
          assert(typeof b.version === "string", "VERSION_REQUIRED");
          const release = await ctx.db.one(
            "extension_versions",
            "published=eq.true",
          );
          const link = release
            ? release.download_link ||
              (await ctx.sign("gptyar-releases", release.storage_path))
            : null;
          return json(updateResponse(release, b.version, link));
        }
        if (path === "/public/download" && req.method === "GET") {
          const r = await ctx.db.one("extension_versions", "published=eq.true");
          assert(r, "NO_PUBLISHED_VERSION", 404);
          return new Response(null, {
            status: 302,
            headers: {
              ...HEADERS,
              Location: r.download_link ||
                (await ctx.sign("gptyar-releases", r.storage_path)),
            },
          });
        }
      }
      throw new AppError("NOT_FOUND", 404);
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      return json(
        {
          error: e instanceof AppError ? e.code : "INTERNAL_ERROR",
          request_id: crypto.randomUUID(),
        },
        status,
      );
    }
  };
}
