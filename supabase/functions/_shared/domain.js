export class AppError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
    this.dbCode = "";
  }
}
export const assert = (ok, code, status) => {
  if (!ok) throw new AppError(code, status);
};
export const digits = (v) =>
  String(v)
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
    .trim();
export function positiveInt(v, max = 10000) {
  const s = digits(v);
  assert(/^\d+$/.test(s), "INVALID_NUMBER");
  const n = Number(s);
  assert(Number.isSafeInteger(n) && n > 0 && n <= max, "INVALID_NUMBER");
  return n;
}
export function expiry(base, unit, quantity, now = Date.now()) {
  assert(["day", "month"].includes(unit), "INVALID_UNIT");
  quantity = positiveInt(quantity);
  const t = Math.max(
    Number.isFinite(Date.parse(base)) ? Date.parse(base) : 0,
    now,
  );
  // One month is exactly 30 * 24 hours, consistently for purchase and renewal.
  return new Date(
    t + quantity * (unit === "month" ? 30 : 1) * 86400000,
  ).toISOString();
}
export function quote(rate, count, discount = null) {
  count = positiveInt(count);
  assert(
    rate.enabled && count >= rate.min_quantity && count <= rate.max_quantity,
    "DURATION_NOT_AVAILABLE",
  );
  const subtotal = count * Number(rate.unit_price_rial);
  assert(Number.isSafeInteger(subtotal) && subtotal > 0, "INVALID_AMOUNT");
  let off = 0;
  if (discount)
    off =
      discount.kind === "percent"
        ? Math.floor((subtotal * discount.value) / 100)
        : Number(discount.value);
  off = Math.max(0, Math.min(subtotal - 1, off));
  return {
    subtotal_rial: subtotal,
    discount_rial: off,
    total_rial: subtotal - off,
  };
}
export function normalizeSubscriber(s) {
  assert(
    s &&
      typeof s === "object" &&
      typeof s.subscriptionId === "string" &&
      s.subscriptionId.length > 0,
    "GPTYAR_CONTRACT_MISMATCH",
    502,
  );
  const date = s.expiresAt;
  assert(
    date == null || Number.isFinite(Date.parse(date)),
    "GPTYAR_CONTRACT_MISMATCH",
    502,
  );
  if (s.token != null)
    assert(
      typeof s.token === "string" &&
        s.token.length > 0 &&
        !s.token.startsWith("@"),
      "UNSAFE_SUBSCRIBER_TOKEN",
      502,
    );
  return {
    subscriptionId: s.subscriptionId,
    name: String(s.name || ""),
    token: s.token,
    expiresAt: date,
    isActive: s.isActive,
  };
}
export function verifyTransaction(order, payment, tx, user) {
  assert(String(order.bale_user_id) === String(user), "PAYER_MISMATCH");
  assert(
    payment.currency === "IRR" &&
      payment.total_amount === Number(order.total_rial),
    "PAYMENT_AMOUNT_MISMATCH",
  );
  assert(payment.invoice_payload === order.id, "PAYLOAD_MISMATCH");
  assert(
    String(tx.id) === String(payment.telegram_payment_charge_id) &&
      tx.status === "paid",
    "TRANSACTION_NOT_PAID",
  );
  assert(
    String(tx.userID) === String(user) &&
      Number(tx.amount) === Number(order.total_rial),
    "TRANSACTION_MISMATCH",
  );
  return true;
}
export function checkLimits(
  profile,
  listing,
  desiredExpiry,
  intent,
  reserved = 0,
  reviewed = {},
) {
  const limits = {
    ...(profile.account?.limits || {}),
    ...(listing.limits || {}),
  };
  const maxUsers = limits.maxUsers ?? reviewed.maxUsers;
  const maxDays = limits.maxDurationDays ?? reviewed.maxDurationDays;
  // No universal 20-user / 60-day default: those are UI defaults in 4.6.5, not a server contract.
  assert(
    reviewed.confirmed === true ||
      (Number.isInteger(maxUsers) && Number.isFinite(maxDays)),
    "LIMITS_NOT_VERIFIED",
    409,
  );
  if (maxDays != null)
    assert(
      Date.parse(desiredExpiry) <=
        Date.now() + Number(maxDays) * 86400000 + 1000,
      "ENTERPRISE_EXPIRY_LIMIT",
      409,
    );
  const maxExpiry = limits.maxExpiresAt ?? reviewed.maxExpiresAt;
  if (maxExpiry)
    assert(
      Date.parse(desiredExpiry) <= Date.parse(maxExpiry),
      "ENTERPRISE_EXPIRY_LIMIT",
      409,
    );
  if (intent === "purchase" && maxUsers != null)
    assert(
      listing.subscribers.length + reserved < Number(maxUsers),
      "ENTERPRISE_USER_LIMIT",
      409,
    );
}
export function compareVersions(a, b) {
  const parse = (s) => {
    assert(/^\d+(\.\d+){0,3}$/.test(s), "INVALID_VERSION");
    const n = s.split(".").map(Number);
    assert(
      n.every((x) => x <= 65535),
      "INVALID_VERSION",
    );
    return n;
  };
  const x = parse(a),
    y = parse(b);
  for (let i = 0; i < 4; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
export function updateResponse(release, current, downloadLink) {
  if (!release)
    return {
      updateAvailable: false,
      versionAction: "none",
      updateMode: "OPTIONAL",
    };
  const d = compareVersions(release.version, current),
    available = d !== 0 && (d > 0 || release.rollback === true);
  return {
    updateAvailable: available,
    versionAction: available ? (d < 0 ? "rollback" : "update") : "none",
    updateMode: release.update_mode,
    downloadLink: available ? downloadLink : null,
    targetVersion: release.version,
    latestVersion: release.version,
    sha256: release.sha256,
    changelog: release.changelog,
  };
}
export const cleanName = (v) => {
  const s = String(v || "").trim();
  assert(/^[\p{L}\p{M}\s\-‌]{2,50}$/u.test(s), "INVALID_NAME");
  return s;
};
