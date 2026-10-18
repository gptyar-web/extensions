/* DOM-only UI fixtures: does not claim browser rendering, real video decoding or external connectivity. */
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
async function until(fn) {
  const end = Date.now() + 2000;
  while (!fn()) {
    if (Date.now() > end) throw Error("UI state timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("admin UI preserves single-token login and renders all twelve commerce pages with backend data", async (t) => {
  const errors = [],
    v = new VirtualConsole();
  v.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM(read("index.html"), {
    runScripts: "outside-only",
    url: "https://gptyar-web.github.io/extensions/",
    virtualConsole: v,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  Object.defineProperty(w, "crypto", { value: webcrypto });
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const settings = {
    bot: { enabled: false, connected: false },
    wallet: { mode: "test", enabled: false, verified: false },
    limits: { confirmed: false },
    support: {
      url: "https://eitaa.com/gptyar",
      site: "https://gptyar-web.github.io",
    },
  };
  const calls = [];
  w.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname.split("/gptyar-api")[1];
    calls.push({ path, options });
    let d = [];
    if (path === "/api/login")
      d = {
        session: "s".repeat(43),
        profile: {
          message: "fixture",
          account: {
            id: "fixture",
            totalSubscriptions: 0,
            activeSubscriptions: 0,
          },
          agent: { name: "fixture" },
        },
      };
    if (path === "/api/subscribers")
      d = { accountId: "fixture", subscribers: [] };
    if (path === "/api/dashboard")
      d = {
        metrics: Object.fromEntries(
          [
            "customers",
            "active",
            "expired",
            "orders_today",
            "successful",
            "failed",
            "sales",
            "daily",
            "monthly",
            "renewals",
            "tokens",
            "pending",
            "needs_review",
          ].map((k) => [k, 0]),
        ),
        connections: {
          gptyar: { connected: true },
          bot: settings.bot,
          wallet: settings.wallet,
        },
      };
    if (path === "/api/settings")
      d = {
        settings,
        secrets: [],
        extension_version: "4.6.5",
        update_endpoint:
          "https://fixture.supabase.co/functions/v1/gptyar-api/public/check-for-update",
      };
    if (path === "/api/pricing")
      d = [
        {
          unit: "day",
          unit_price_rial: 350000,
          enabled: true,
          min_quantity: 1,
          max_quantity: 60,
        },
        {
          unit: "month",
          unit_price_rial: 10000000,
          enabled: true,
          min_quantity: 1,
          max_quantity: 2,
        },
      ];
    if (path === "/api/logout") d = { ok: true };
    return new Response(JSON.stringify(d), {
      headers: { "Content-Type": "application/json" },
    });
  };
  w.eval(
    "window.ADMIN_PANEL_CONFIG={API_BASE_URL:'https://fixture.supabase.co/functions/v1/gptyar-api'}",
  );
  w.eval(read("assets/app.js"));
  w.eval(read("assets/commerce.js"));
  assert.equal(w.document.querySelectorAll("#loginForm input").length, 1);
  const input = w.document.getElementById("adminToken");
  input.value = "@ui-fixture-token";
  w.document
    .getElementById("loginForm")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !w.document.getElementById("dashboard").hidden);
  assert.equal(input.value, "");
  for (const page of [
    "bot",
    "wallet",
    "settings",
    "pricing",
    "discounts",
    "orders",
    "renewals",
    "payments",
    "videos",
    "releases",
    "reports",
    "logs",
  ]) {
    w.document.querySelector('#sidebarNav [data-page="' + page + '"]').click();
    const host = w.document.getElementById("commerce-" + page);
    await until(() => !host.textContent.includes("در حال دریافت"));
    assert(!host.querySelector(".field-error"), "page failed " + page);
    assert(!w.document.getElementById("page-" + page).hidden);
  }
  assert.equal(w.localStorage.length, 0);
  assert.equal(w.sessionStorage.length, 0);
  const call = calls.find((c) => c.path === "/api/settings");
  assert.equal(call.options.headers.Authorization, "Bearer " + "s".repeat(43));
  assert(!JSON.stringify(call).includes("@ui-fixture-token"));
  w.document.getElementById("logoutBtn").click();
  await until(() => w.document.getElementById("dashboard").hidden);
  assert(calls.some((c) => c.path === "/api/logout"));
  assert.equal(errors.length, 0, errors.join("\n"));
});
