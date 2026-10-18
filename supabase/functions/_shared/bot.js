import {
  assert,
  positiveInt,
  expiry,
  quote,
  checkLimits,
  cleanName,
  AppError,
} from "./domain.js";
import { hash } from "./crypto.js";
export const MENU = [
  ["خرید حساب اشتراکی", "تمدید اشتراک"],
  ["اشتراک‌های من", "بررسی اعتبار اشتراک"],
  ["راهنمای فعال‌سازی", "ارتباط با پشتیبانی"],
  ["اتصال اشتراک قدیمی"],
];
const BACK = [["بازگشت", "انصراف"]];
const fa = (n) => new Intl.NumberFormat("fa-IR").format(n);
export async function ownedOrder(ctx, id, user) {
  assert(/^[a-f0-9-]{36}$/.test(String(id)), "INVALID_ORDER");
  const o = await ctx.db.one("orders", `id=eq.${id}`);
  assert(o, "ORDER_NOT_FOUND", 404);
  const c = await ctx.db.one("bot_customers", `id=eq.${o.customer_id}`);
  assert(String(c.bale_user_id) === String(user), "NOT_OWNER", 403);
  return { ...o, bale_user_id: String(c.bale_user_id) };
}
export async function preCheckout(ctx, q) {
  const client = await ctx.bot();
  let ok = false;
  try {
    const [o, wallet, bot] = await Promise.all([
      ownedOrder(ctx, q.invoice_payload, q.from.id),
      ctx.setting("wallet"),
      ctx.setting("bot"),
    ]);
    ok =
      (o.purpose === "wallet_probe" || (bot.enabled && wallet.enabled)) &&
      o.mode === wallet.mode &&
      o.wallet_revision === wallet.revision &&
      (o.mode === "test" || wallet.verified || o.purpose === "wallet_probe") &&
      (o.purpose === "wallet_probe" || bot.enabled) &&
      o.status === "pending_payment" &&
      Date.parse(o.invoice_expires_at) > Date.now() &&
      q.currency === "IRR" &&
      q.total_amount === Number(o.total_rial);
    if (ok)
      ok = await ctx.db.rpc("precheckout", {
        p_order: o.id,
        p_user: Number(q.from.id),
        p_amount: q.total_amount,
        p_currency: q.currency,
        p_charge: q.id,
      });
  } catch {
    /* Reject malformed and foreign invoices without leaking their details. */
  }
  await client.call(
    "answerPreCheckoutQuery",
    {
      pre_checkout_query_id: q.id,
      ok,
      ...(!ok
        ? {
            error_message:
              "سفارش نامعتبر، منقضی یا پرداخت غیرفعال است. لطفاً دوباره از منوی خرید اقدام کنید.",
          }
        : {}),
    },
    1800,
  );
}
export async function createInvoice(ctx, c, draft) {
  const wallet = await ctx.setting("wallet");
  assert(
    wallet.enabled && (wallet.mode === "test" || wallet.verified),
    "PAYMENT_DISABLED",
    409,
  );
  const token = await ctx.secret("gptyar_automation"),
    auth = await ctx.gpt.authorize(token);
  await ctx.scope(auth.profile);
  let sub = null;
  if (draft.intent === "renewal") {
    sub = await ctx.db.one(
      "subscriptions",
      `id=eq.${draft.subscription_id}&customer_id=eq.${c.id}`,
    );
    assert(sub, "NOT_OWNER", 403);
    const remote = auth.listing.subscribers.find(
      (s) => s.subscriptionId === sub.gptyar_subscription_id,
    );
    assert(remote && remote.expiresAt, "SUBSCRIPTION_NOT_FOUND", 409);
    sub.expires_at = remote.expiresAt;
  }
  const desired = expiry(sub?.expires_at, draft.unit, draft.quantity);
  const reviewed = await ctx.setting("limits");
  checkLimits(auth.profile, auth.listing, desired, draft.intent, 0, reviewed);
  const maxUsers =
    auth.listing.limits?.maxUsers ??
    auth.profile.account.limits?.maxUsers ??
    reviewed.maxUsers ??
    null;
  const o = await ctx.db.rpc("new_order", {
    p_customer: c.id,
    p_intent: draft.intent,
    p_unit: draft.unit,
    p_quantity: draft.quantity,
    p_mode: wallet.mode,
    p_code: draft.code || null,
    p_subscription: sub?.id || null,
    p_max_users: maxUsers,
    p_server_count: auth.listing.subscribers.length,
  });
  const bot = await ctx.bot();
  try {
    const provider =
      wallet.mode === "test"
        ? "WALLET-TEST-1111111111111111"
        : await ctx.secret("bale_provider");
    const sent = await bot.call("sendInvoice", {
      chat_id: String(c.bale_user_id),
      title: "اشتراک ChatGPT Plus",
      description: `${o.intent === "renewal" ? "تمدید" : "خرید"} ${fa(o.quantity)} ${o.unit === "day" ? "روز" : "ماه"}؛ هر ماه ۳۰ روز. صورتحساب ۲۰ دقیقه اعتبار دارد.${o.mode === "test" ? " پرداخت آزمایشی؛ حساب واقعی صادر نمی‌شود." : ""}`,
      payload: o.id,
      provider_token: provider,
      prices: [{ label: "اشتراک پس از تخفیف", amount: Number(o.total_rial) }],
    });
    await ctx.db.patch("orders", `id=eq.${o.id}`, {
      invoice_message_id: String(sent.message_id),
    });
  } catch (e) {
    await ctx.event(e.code || "INVOICE_RESULT_UNCERTAIN", o.id);
    throw new AppError("INVOICE_RESULT_UNCERTAIN", 502);
  }
  return o;
}
export async function processUpdate(ctx, u) {
  if (u.pre_checkout_query) return; // Already answered synchronously at ingress.
  const message = u.message;
  if (
    !message ||
    message.chat?.type !== "private" ||
    !message.from ||
    message.from.is_bot ||
    String(message.chat.id) !== String(message.from.id) ||
    message.sender_chat
  )
    return;
  const user = String(message.from.id);
  assert(/^\d{1,16}$/.test(user), "INVALID_USER");
  await ctx.rate("bot:" + user, 40, 60);
  await ctx.db.request(
    "bot_customers?on_conflict=bale_user_id",
    "POST",
    { bale_user_id: user },
    "resolution=ignore-duplicates,return=representation",
  );
  const c = await ctx.db.one("bot_customers", `bale_user_id=eq.${user}`),
    bot = await ctx.bot();
  if (message.successful_payment) {
    await handlePayment(ctx, message.successful_payment, user);
    return;
  }
  const pairing = /^\/start admin_([A-Za-z0-9_-]{43})$/.exec(
    String(message.text || ""),
  );
  if (pairing) {
    const paired = await ctx.db.rpc("pair_admin", {
      p_hash: await hash(pairing[1]),
      p_user: Number(user),
    });
    await bot.send(
      user,
      paired
        ? "اعلان‌های مدیریتی به این گفت‌وگوی خصوصی متصل شد."
        : "پیوند اتصال مدیر نامعتبر یا منقضی شده است.",
      MENU,
    );
    return;
  }
  if (!(await ctx.setting("bot")).enabled) return;
  let conversation = (await ctx.db.one(
    "bot_conversations",
    `customer_id=eq.${c.id}`,
  )) || { step: "menu", context: {} };
  if (
    conversation.last_update_id != null &&
    Number(u.update_id) <= Number(conversation.last_update_id)
  )
    return;
  const say = (s, k = BACK) => bot.send(user, s, k);
  const save = async (step, context = {}) => {
    await ctx.db.request(
      "bot_conversations?on_conflict=customer_id",
      "POST",
      { customer_id: c.id, step, context, last_update_id: u.update_id },
      "resolution=merge-duplicates,return=representation",
    );
  };
  const text = String(message.text || "").trim(),
    s = conversation.step,
    d = { ...conversation.context };
  // Paid orders take precedence over any abandoned draft and survive /start and server restarts.
  const pending = await ctx.db.one(
    "orders",
    `customer_id=eq.${c.id}&status=eq.awaiting_customer_details&order=paid_at.asc`,
  );
  if (pending && !["first_name", "last_name"].includes(s)) {
    await save("first_name", { order_id: pending.id });
    await say(
      "پرداخت شما تأیید شده است. برای تکمیل سفارش، نام خود را وارد کنید.",
    );
    return;
  }
  if (text === "انصراف" || text === "بازگشت" || text.startsWith("/start")) {
    if (text === "انصراف")
      await ctx.db.rpc("cancel_unpaid", { p_customer: c.id });
    await save("menu");
    await say(
      pending
        ? "سفارش پرداخت‌شده محفوظ است. برای ادامه یک پیام بفرستید."
        : "به جی‌پی‌تی‌یار خوش آمدید. خرید خودکار فقط برای حساب اشتراکی ChatGPT Plus فعال است.",
      MENU,
    );
    return;
  }
  if (s === "first_name") {
    d.first_name = cleanName(text);
    await save("last_name", d);
    await say("نام خانوادگی خود را وارد کنید.");
    return;
  }
  if (s === "last_name") {
    const last = cleanName(text);
    await ctx.db.rpc("customer_details", {
      p_order: d.order_id,
      p_customer: c.id,
      p_first: d.first_name,
      p_last: last,
    });
    await save("menu");
    await say(
      "اطلاعات ثبت شد. صدور حساب در صف پردازش است؛ نتیجه همین‌جا ارسال می‌شود.",
      MENU,
    );
    return;
  }
  if (
    text === "ارتباط با پشتیبانی" ||
    /ChatGPT (Go|Pro)|اختصاصی|شخصی/.test(text)
  ) {
    await say(
      "برای حساب Go، Pro، Plus اختصاصی یا فعال‌سازی حساب شخصی با پشتیبانی هماهنگ کنید:\n" +
        (await ctx.setting("support")).url,
      MENU,
    );
    return;
  }
  if (text === "راهنمای فعال‌سازی") {
    await say(
      "افزونه را از بخش دانلود سایت نصب کنید، توکن اختصاصی خود را در افزونه وارد کنید و آموزش دستگاه خود را در سایت ببینید:\n" +
        (await ctx.setting("support")).site,
      MENU,
    );
    return;
  }
  if (text === "خرید حساب اشتراکی") {
    await save("unit", { intent: "purchase" });
    await say(
      "مدت حساب اشتراکی ChatGPT Plus را انتخاب کنید. هر ماه دقیقاً ۳۰ روز است.",
      [["روزانه", "ماهانه"], ...BACK],
    );
    return;
  }
  if (text === "تمدید اشتراک") {
    const subs = await ctx.db.request(
      `subscriptions?customer_id=eq.${c.id}&order=created_at.desc`,
    );
    if (!subs.length) {
      await say(
        "اشتراکی برای شما ثبت نشده است. برای اشتراک قدیمی گزینه اتصال اشتراک قدیمی را انتخاب کنید.",
        MENU,
      );
      return;
    }
    await save("renew_select", { ids: subs.map((x) => x.id) });
    await say(
      subs
        .map(
          (x, i) =>
            `${fa(i + 1)}. ${x.name}؛ انقضا: ${new Date(x.expires_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
        )
        .join("\n") + "\nشماره اشتراک خود را وارد کنید.",
    );
    return;
  }
  if (text === "اشتراک‌های من" || text === "بررسی اعتبار اشتراک") {
    const subs = await ctx.db.request(
      `subscriptions?customer_id=eq.${c.id}&order=created_at.desc`,
    );
    if (!subs.length) {
      await say("اشتراکی برای شما ثبت نشده است.", MENU);
      return;
    }
    const token = await ctx.secret("gptyar_automation"),
      listing = await ctx.gpt.list(token);
    for (const sub of subs) {
      const remote = listing.subscribers.find(
        (x) => x.subscriptionId === sub.gptyar_subscription_id,
      );
      if (!remote) {
        await say(
          "اشتراک در سرور پیدا نشد. پشتیبانی می‌تواند بررسی کند.",
          MENU,
        );
        continue;
      }
      const actual = remote.expiresAt;
      await say(
        `${sub.name}\nانقضای واقعی: ${actual ? new Date(actual).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }) : "نامشخص"}\nوضعیت: ${remote.isActive !== false && Date.parse(actual) > Date.now() ? "فعال" : "منقضی یا غیرفعال"}`,
        MENU,
      );
    }
    return;
  }
  if (text === "اتصال اشتراک قدیمی") {
    await save("claim");
    await say(
      "توکن اختصاصی اشتراک قدیمی خود را وارد کنید. اتصال پس از تطبیق سابقه مالکیت و تأیید مدیر انجام می‌شود. توکن مدیریتی ارسال نکنید.",
    );
    return;
  }
  if (s === "claim") {
    assert(
      text.length >= 5 &&
        text.length <= 512 &&
        !text.startsWith("@") &&
        !/\s/.test(text),
      "INVALID_SUBSCRIBER_TOKEN",
    );
    const fingerprint = await hash(text),
      cipher = await ctx.encrypt(text, "ownership:" + fingerprint);
    await ctx.db.request(
      "ownership_claims?on_conflict=customer_id,token_fingerprint",
      "POST",
      {
        customer_id: c.id,
        token_ciphertext: cipher,
        token_fingerprint: fingerprint,
      },
      "resolution=ignore-duplicates,return=representation",
    );
    await save("menu");
    await say(
      "درخواست اتصال ثبت شد. مدیر پس از احراز سابقه خرید آن را بررسی می‌کند.",
      MENU,
    );
    return;
  }
  if (s === "renew_select") {
    const i = positiveInt(text, d.ids.length) - 1;
    await save("unit", { intent: "renewal", subscription_id: d.ids[i] });
    await say("نوع مدت تمدید را انتخاب کنید.", [["روزانه", "ماهانه"], ...BACK]);
    return;
  }
  if (s === "unit") {
    assert(["روزانه", "ماهانه"].includes(text), "SELECT_DURATION");
    d.unit = text === "روزانه" ? "day" : "month";
    const rate = await ctx.db.one(
      "pricing_rules",
      `product_id=eq.chatgpt-plus-shared&unit=eq.${d.unit}`,
    );
    assert(rate?.enabled, "DURATION_NOT_AVAILABLE");
    await save("quantity", d);
    await say(
      `تعداد ${d.unit === "day" ? "روز" : "ماه"} را وارد کنید (${fa(rate.min_quantity)} تا ${fa(rate.max_quantity)}).\nتعرفه هر واحد: ${fa(rate.unit_price_rial)} ریال.`,
    );
    return;
  }
  if (s === "quantity") {
    d.quantity = positiveInt(text);
    await showSummary(ctx, c, d, save, say);
    return;
  }
  if (s === "summary" && text === "کد تخفیف دارم") {
    await save("discount", d);
    await say("کد تخفیف خود را وارد کنید.");
    return;
  }
  if (s === "discount") {
    d.code = text.toUpperCase();
    assert(/^[A-Z0-9_-]{3,40}$/.test(d.code), "DISCOUNT_INVALID");
    await showSummary(ctx, c, d, save, say);
    return;
  }
  if (s === "summary" && text === "پرداخت") {
    const order = await createInvoice(ctx, c, d);
    await save("menu");
    await say(
      `صورتحساب سفارش ${order.id} صادر شد. مبلغ نهایی ${fa(order.total_rial)} ریال. پس از پرداخت تأییدشده، نام و نام خانوادگی دریافت می‌شود.`,
      MENU,
    );
    return;
  }
  await say("برای ادامه یکی از دکمه‌های منو را انتخاب کنید.", MENU);
}
async function showSummary(ctx, c, d, save, say) {
  const rate = await ctx.db.one(
    "pricing_rules",
    `product_id=eq.chatgpt-plus-shared&unit=eq.${d.unit}`,
  );
  let discount = null;
  if (d.code) {
    discount = await ctx.db.one(
      "discount_codes",
      `code=eq.${encodeURIComponent(d.code)}`,
    );
    assert(
      discount?.active &&
        !discount.archived &&
        Date.parse(discount.starts_at) <= Date.now() &&
        (!discount.ends_at || Date.parse(discount.ends_at) > Date.now()) &&
        [d.intent, "both"].includes(discount.scope),
      "DISCOUNT_INVALID",
    );
  }
  const q = quote(rate, d.quantity, discount);
  await save("summary", d);
  await say(
    `ChatGPT Plus اشتراکی\n${d.intent === "renewal" ? "تمدید" : "خرید"} ${fa(d.quantity)} ${d.unit === "day" ? "روز" : "ماه"}\nمبلغ اولیه: ${fa(q.subtotal_rial)} ریال\nتخفیف: ${fa(q.discount_rial)} ریال\nمبلغ نهایی: ${fa(q.total_rial)} ریال (${fa(q.total_rial / 10)} تومان)\nقیمت و ظرفیت هنگام صدور صورتحساب دوباره بررسی می‌شود.`,
    [["پرداخت", "کد تخفیف دارم"], ...BACK],
  );
}
export async function handlePayment(ctx, p, user) {
  const fingerprint = String(p.telegram_payment_charge_id || "");
  assert(
    fingerprint.length > 0 && fingerprint.length <= 200,
    "INVALID_PAYMENT",
  );
  await ctx.db.request(
    "payment_receipts?on_conflict=charge_id",
    "POST",
    {
      charge_id: fingerprint,
      payer_bale_id: Number(user),
      payload_ciphertext: await ctx.encrypt(
        JSON.stringify(p),
        "receipt:" + fingerprint,
      ),
    },
    "resolution=ignore-duplicates,return=representation",
  );
  try {
    const o = await ownedOrder(ctx, p.invoice_payload, user);
    assert(
      p.currency === "IRR" && p.total_amount === Number(o.total_rial),
      "PAYMENT_AMOUNT_MISMATCH",
    );
    assert(
      typeof p.telegram_payment_charge_id === "string" &&
        p.telegram_payment_charge_id.length <= 200 &&
        typeof p.provider_payment_charge_id === "string" &&
        p.provider_payment_charge_id.length <= 200,
      "INVALID_PAYMENT",
    );
    // Persist the successful-payment receipt before any inquiry network call. A later outage cannot lose it.
    await ctx.db.rpc("record_payment", {
      p_order: o.id,
      p_user: Number(user),
      p_amount: p.total_amount,
      p_currency: p.currency,
      p_charge: p.telegram_payment_charge_id,
      p_provider: p.provider_payment_charge_id,
      p_verified: false,
    });
    await ctx.db.patch(
      "payment_receipts",
      `charge_id=eq.${encodeURIComponent(fingerprint)}`,
      { status: "matched", order_id: o.id },
    );
  } catch (e) {
    await ctx.db.patch(
      "payment_receipts",
      `charge_id=eq.${encodeURIComponent(fingerprint)}`,
      {
        status: "needs_review",
        error_code: e.code || "PAYMENT_RECEIPT_REQUIRES_REVIEW",
      },
    );
    await ctx.event(e.code || "PAYMENT_RECEIPT_REQUIRES_REVIEW");
    throw e;
  }
}
