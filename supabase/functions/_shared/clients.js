import { AppError, assert, normalizeSubscriber } from "./domain.js";
export class Database {
  constructor(env, timeout = 8000) {
    this.env = env;
    this.timeout = timeout;
  }
  async request(path, method = "GET", body, prefer = "return=representation") {
    const r = await fetch(`${this.env.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: prefer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new AppError(
        data?.message?.match(/^[A-Z_]+$/)?.[0] || "DATABASE_ERROR",
        r.status === 409 ? 409 : 503,
      );
      e.dbCode = data?.code;
      throw e;
    }
    return data;
  }
  rpc(name, args = {}) {
    return this.request(`rpc/gy_${name}`, "POST", args);
  }
  async one(table, query) {
    return (await this.request(`${table}?${query}&limit=1`))[0] || null;
  }
  insert(table, body) {
    return this.request(table, "POST", body);
  }
  patch(table, query, body) {
    return this.request(`${table}?${query}`, "PATCH", body);
  }
}
export class GPTYar {
  constructor(version = "4.6.5", transport = fetch) {
    this.version = version;
    this.transport = transport;
  }
  async call(path, method, token, body) {
    const r = await this.transport(`https://api.gptyar.com${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok)
      throw new AppError(
        ["ENTERPRISE_USER_LIMIT", "ENTERPRISE_EXPIRY_LIMIT"].includes(d?.code)
          ? d.code
          : r.status === 401 || r.status === 403
            ? "GPTYAR_UNAUTHORIZED"
            : "GPTYAR_UPSTREAM_ERROR",
        r.status === 401 || r.status === 403 ? 401 : 502,
      );
    assert(d && !d.error, "GPTYAR_CONTRACT_MISMATCH", 502);
    return d;
  }
  async authorize(token) {
    assert(
      typeof token === "string" &&
        /^@[^\s\u0000-\u001f\u007f]{1,511}$/.test(token),
      "ADMIN_TOKEN_REQUIRED",
      401,
    );
    const p = await this.call("/accupdator/validate", "POST", token, {
      token,
      version: this.version,
    });
    assert(p.message && p.account?.id && p.agent, "ADMIN_NOT_CONFIRMED", 403);
    const list = await this.list(token);
    assert(
      String(list.accountId) === String(p.account.id),
      "ADMIN_SCOPE_MISMATCH",
      403,
    );
    // Successful management-only listing is an actual capability check; '@' or message alone is insufficient.
    return { profile: p, listing: list };
  }
  async list(token) {
    const d = await this.call("/accupdator/subscribers/all", "GET", token);
    assert(
      d.accountId && Array.isArray(d.subscribers),
      "GPTYAR_CONTRACT_MISMATCH",
      502,
    );
    return { ...d, subscribers: d.subscribers.map(normalizeSubscriber) };
  }
  create(token, name, expiresAt) {
    return this.call("/accupdator/subscribers/create", "POST", token, {
      name,
      expiresAt,
    });
  }
  update(token, subscriptionId, expiresAt) {
    return this.call("/accupdator/subscribers/update", "PATCH", token, {
      subscriptionId,
      expiresAt,
    });
  }
}
export class Bale {
  constructor(token, transport = fetch) {
    this.token = token;
    this.transport = transport;
  }
  async call(method, body = {}, timeout = 8000) {
    let r;
    try {
      r = await this.transport(
        `https://tapi.bale.ai/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(timeout),
        },
      );
    } catch {
      throw new AppError("BALE_UNREACHABLE", 502);
    }
    const d = await r.json().catch(() => null);
    assert(r.ok && d?.ok === true, "BALE_API_ERROR", 502);
    return d.result;
  }
  send(user, text, keyboard) {
    return this.call("sendMessage", {
      chat_id: String(user),
      text,
      ...(keyboard
        ? {
            reply_markup: {
              keyboard: keyboard.map((row) => row.map((text) => ({ text }))),
              resize_keyboard: true,
            },
          }
        : {}),
    });
  }
}
