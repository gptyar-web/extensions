import {
  assert,
  expiry,
  normalizeSubscriber,
  verifyTransaction,
  checkLimits,
  AppError,
} from "./domain.js";
import { hash } from "./crypto.js";
import { processUpdate, MENU } from "./bot.js";
export async function runJobs(ctx, max = 4) {
  const owner = crypto.randomUUID();
  if (
    !(await ctx.db.rpc("lease", {
      p_key: "commerce-worker",
      p_owner: owner,
      p_seconds: 180,
    }))
  )
    return { busy: true };
  await ctx.set("worker", { last_run_at: new Date().toISOString() });
  let count = 0;
  const start = Date.now();
  try {
    while (count < max && Date.now() - start < 40000) {
      const [job] = await ctx.db.rpc("claim_job");
      if (!job) break;
      try {
        if (job.kind === "bot_update") {
          const update = await ctx.db.one(
            "bot_updates",
            `update_id=eq.${job.aggregate_id}`,
          );
          const u = JSON.parse(
            await ctx.decrypt(
              update.payload_ciphertext,
              "update:" + job.aggregate_id,
            ),
          );
          try {
            await processUpdate(ctx, u);
          } catch (e) {
            // Invalid user input is a completed update, not a poisoned queue item.
            if (e.status === 400 || e.status === 409) {
              const m = u.message;
              if (
                m?.chat?.type === "private" &&
                String(m.chat.id) === String(m.from?.id)
              )
                await (
                  await ctx.bot()
                ).send(m.chat.id, botError(e.code), [["بازگشت", "انصراف"]]);
            } else throw e;
          }
          await ctx.db.patch(
            "bot_updates",
            `update_id=eq.${job.aggregate_id}`,
            { state: "done" },
          );
        } else if (job.kind === "verify_payment")
          await verifyPayment(ctx, job.aggregate_id);
        else if (job.kind === "provision")
          await provision(ctx, job.aggregate_id);
        else if (job.kind === "admin_notice") {
          const settings = await ctx.setting("notifications");
          if (settings.enabled && settings.bale_user_id)
            await (
              await ctx.bot()
            ).send(
              settings.bale_user_id,
              `اعلان مدیریت GPT Yar\nسفارش: ${job.aggregate_id}\nنیازمند بررسی: ${job.payload.code}\nبرای رسیدگی، بخش سفارش‌ها و گزارش خطاها را در پنل باز کنید.`,
            );
        } else if (job.kind === "deliver") await deliver(ctx, job.aggregate_id);
        await ctx.db.patch(
          "outbox_jobs",
          `id=eq.${job.id}&lease_token=eq.${job.lease_token}`,
          { state: "done", locked_until: null },
        );
      } catch (e) {
        const code = e.code || "JOB_PROCESSING_ERROR",
          final = job.attempts >= 8;
        await ctx.db.patch(
          "outbox_jobs",
          `id=eq.${job.id}&lease_token=eq.${job.lease_token}`,
          {
            state: final ? "failed" : "pending",
            locked_until: null,
            last_error: code,
            available_at: new Date(
              Date.now() + Math.min(3600, 2 ** job.attempts * 5) * 1000,
            ).toISOString(),
          },
        );
        await ctx.event(
          code,
          job.kind === "bot_update" ? null : job.aggregate_id,
        );
        if (final && !["bot_update", "admin_notice"].includes(job.kind)) {
          await ctx.db.patch(
            "orders",
            `id=eq.${job.aggregate_id}&status=neq.completed`,
            { status: "needs_review", error_code: code },
          );
        }
      }
      count++;
    }
  } finally {
    await ctx.db.patch(
      "resource_leases",
      `key=eq.commerce-worker&owner=eq.${owner}`,
      { until_at: new Date(0).toISOString() },
    );
  }
  return { processed: count };
}
function botError(code) {
  return (
    {
      INVALID_NAME: "نام را با حروف و بین ۲ تا ۵۰ نویسه وارد کنید.",
      INVALID_NUMBER: "یک عدد صحیح معتبر با رقم فارسی یا انگلیسی وارد کنید.",
      DISCOUNT_INVALID: "کد تخفیف معتبر نیست یا برای این سفارش فعال نیست.",
      DISCOUNT_EXHAUSTED: "ظرفیت کد تخفیف تمام شده است.",
      DISCOUNT_CUSTOMER_LIMIT: "سهم استفاده شما از این کد تمام شده است.",
      ENTERPRISE_USER_LIMIT: "ظرفیت حساب تکمیل است؛ فعلاً پرداخت انجام ندهید.",
      ENTERPRISE_EXPIRY_LIMIT:
        "مدت انتخابی با محدودیت سرور سازگار نیست؛ مدت کوتاه‌تری انتخاب کنید.",
      LIMITS_NOT_VERIFIED:
        "حدود مجاز فروش هنوز توسط سرور یا مدیر تأیید نشده است.",
      PAYMENT_DISABLED: "پرداخت فعلاً فعال نیست.",
      DURATION_NOT_AVAILABLE:
        "فروش این مدت غیرفعال است یا تعداد خارج از محدوده است.",
      CONNECTION_NOT_CONFIGURED:
        "اتصال موردنیاز هنوز توسط مدیر تنظیم نشده است.",
    }[code] || "ورودی یا وضعیت سفارش معتبر نیست. با بازگشت دوباره تلاش کنید."
  );
}
export async function verifyPayment(ctx, id) {
  const o = await ctx.db.one("orders", `id=eq.${id}`),
    p = await ctx.db.one("payments", `order_id=eq.${id}`),
    c = await ctx.db.one("bot_customers", `id=eq.${o.customer_id}`);
  if (p.status === "paid") return;
  const tx = await (
    await ctx.bot()
  ).call("inquireTransaction", { transaction_id: p.bale_charge_id });
  if (["failed", "rejected"].includes(tx.status)) {
    await ctx.db.patch("payments", `id=eq.${p.id}`, { status: tx.status });
    await ctx.db.patch("orders", `id=eq.${id}`, {
      status: "failed",
      error_code: "TRANSACTION_" + tx.status.toUpperCase(),
    });
    await (
      await ctx.bot()
    ).send(
      c.bale_user_id,
      "پرداخت ناموفق بود. سفارش شما با وضعیت مشخص ثبت شده است؛ برای خرید دوباره از منو اقدام کنید.",
      MENU,
    );
    return;
  }
  const receipt = await ctx.db.one(
    "payment_receipts",
    `charge_id=eq.${encodeURIComponent(p.bale_charge_id)}&status=eq.matched`,
  );
  assert(receipt, "SUCCESSFUL_PAYMENT_RECEIPT_REQUIRED", 409);
  verifyTransaction(
    { ...o, bale_user_id: c.bale_user_id },
    {
      currency: p.currency,
      total_amount: Number(p.amount_rial),
      invoice_payload: o.id,
      telegram_payment_charge_id: p.bale_charge_id,
    },
    tx,
    c.bale_user_id,
  );
  await ctx.db.rpc("record_payment", {
    p_order: o.id,
    p_user: Number(c.bale_user_id),
    p_amount: Number(p.amount_rial),
    p_currency: p.currency,
    p_charge: p.bale_charge_id,
    p_provider: p.provider_charge_id || "",
    p_verified: true,
  });
  if (o.purpose === "wallet_probe") {
    await ctx.db.patch("orders", `id=eq.${o.id}`, { status: "paid" });
    await ctx.enqueue("provision", o.id, "probe:" + o.id);
  }
  const currentWallet = await ctx.setting("wallet");
  if (o.wallet_revision === currentWallet.revision)
    await ctx.set("wallet", {
      ...currentWallet,
      ...(o.mode === "live"
        ? { verified: true, last_verified_at: new Date().toISOString() }
        : { test_verified: true, test_verified_at: new Date().toISOString() }),
    });
}
async function review(ctx, o, code) {
  await ctx.db.patch("orders", `id=eq.${o.id}`, {
    status: "needs_review",
    error_code: code,
  });
  await ctx.event(code, o.id);
  await ctx.enqueue("admin_notice", o.id, "admin-notice:" + o.id + ":" + code, {
    code,
  });
  await ctx.enqueue("deliver", o.id, "review:" + o.id + ":" + code);
}
export async function provision(ctx, id) {
  const o = await ctx.db.one("orders", `id=eq.${id}`);
  assert(o, "ORDER_NOT_FOUND", 404);
  if (o.status === "completed") return;
  const paid = await ctx.db.one("payments", `order_id=eq.${id}&status=eq.paid`);
  assert(paid, "PAYMENT_NOT_VERIFIED", 409);
  if (o.mode === "test" || o.purpose === "wallet_probe") {
    await ctx.db.patch("orders", `id=eq.${id}`, {
      status: "completed",
      completed_at: new Date().toISOString(),
      error_code: "TEST_NO_PROVISIONING",
    });
    await ctx.enqueue("deliver", id, "test-deliver:" + id);
    return;
  }
  assert(
    ["paid", "provisioning", "needs_review"].includes(o.status),
    "ORDER_NOT_READY",
    409,
  );
  const token = await ctx.secret("gptyar_automation"),
    { profile, listing } = await ctx.gpt.authorize(token);
  await ctx.scope(profile);
  let op = await ctx.db.one("subscription_operations", `order_id=eq.${id}`);
  let existing = null,
    sub = null;
  if (o.intent === "renewal") {
    sub = await ctx.db.one(
      "subscriptions",
      `id=eq.${o.subscription_id}&customer_id=eq.${o.customer_id}`,
    );
    assert(sub, "NOT_OWNER", 403);
    existing = listing.subscribers.find(
      (s) => s.subscriptionId === sub.gptyar_subscription_id,
    );
    assert(existing?.expiresAt, "SUBSCRIPTION_NOT_FOUND", 409);
  }
  if (!op) {
    const name =
      o.intent === "purchase"
        ? `${o.first_name} ${o.last_name} [GY:${o.id}]`
        : existing.name;
    const target = expiry(existing?.expiresAt, o.unit, o.quantity);
    const [created] = await ctx.db.insert("subscription_operations", {
      order_id: id,
      kind: o.intent,
      request_name: name,
      target_expires_at: target,
      previous_expires_at: existing?.expiresAt || null,
    });
    op = created;
  }
  const matching =
    o.intent === "purchase"
      ? listing.subscribers.filter((s) => s.name === op.request_name)
      : [existing];
  if (matching.length > 1) {
    await review(ctx, o, "MULTIPLE_REMOTE_MATCHES");
    return;
  }
  let remote = matching[0];
  if (
    remote &&
    Date.parse(remote.expiresAt) >= Date.parse(op.target_expires_at)
  )
    return finalize(ctx, o, remote);
  if (
    o.intent === "purchase" &&
    ["requesting", "uncertain"].includes(op.phase)
  ) {
    await review(ctx, o, "ISSUANCE_RESULT_UNCERTAIN");
    return; // Never recreate after an ambiguous external mutation.
  }
  if (o.intent === "purchase" && remote) {
    await review(ctx, o, "REMOTE_EXPIRY_MISMATCH");
    return;
  }
  try {
    checkLimits(
      profile,
      listing,
      op.target_expires_at,
      o.intent,
      0,
      await ctx.setting("limits"),
    );
  } catch (e) {
    await review(ctx, o, e.code);
    return;
  }
  await ctx.db.patch("orders", `id=eq.${id}`, { status: "provisioning" });
  await ctx.db.patch("subscription_operations", `id=eq.${op.id}`, {
    phase: "requesting",
  });
  try {
    if (o.intent === "purchase") {
      const response = await ctx.gpt.create(
        token,
        op.request_name,
        op.target_expires_at,
      );
      remote = normalizeSubscriber(response);
      assert(remote.token && remote.expiresAt, "GPTYAR_CONTRACT_MISMATCH", 502);
    } else {
      // Reapplying this absolute expiry is idempotent; duration is not recalculated on retry.
      await ctx.gpt.update(
        token,
        sub.gptyar_subscription_id,
        op.target_expires_at,
      );
      remote = (await ctx.gpt.list(token)).subscribers.find(
        (s) => s.subscriptionId === sub.gptyar_subscription_id,
      );
    }
    assert(
      remote?.expiresAt &&
        Date.parse(remote.expiresAt) >= Date.parse(op.target_expires_at),
      "REMOTE_EXPIRY_MISMATCH",
      502,
    );
    await finalize(ctx, o, remote);
  } catch (e) {
    await ctx.db.patch("subscription_operations", `id=eq.${op.id}`, {
      phase: "uncertain",
      error_code: e.code || "UPSTREAM_RESULT_UNCERTAIN",
    });
    await review(ctx, o, e.code || "UPSTREAM_RESULT_UNCERTAIN");
  }
}
async function finalize(ctx, o, remote) {
  let ciphertext = "",
    fingerprint = "";
  if (o.intent === "purchase") {
    assert(
      remote.token && !remote.token.startsWith("@"),
      "UNSAFE_SUBSCRIBER_TOKEN",
      502,
    );
    fingerprint = await hash(remote.token);
    ciphertext = await ctx.encrypt(
      remote.token,
      "subscription:" + remote.subscriptionId,
    );
  }
  await ctx.db.rpc("complete_order", {
    p_order: o.id,
    p_remote_id: remote.subscriptionId,
    p_account: ctx.env.GPTYAR_ACCOUNT_ID,
    p_ciphertext: ciphertext,
    p_fingerprint: fingerprint,
    p_name: remote.name,
    p_expiry: remote.expiresAt,
  });
}
export async function deliver(ctx, id) {
  const o = await ctx.db.one("orders", `id=eq.${id}`),
    c = await ctx.db.one("bot_customers", `id=eq.${o.customer_id}`),
    bot = await ctx.bot();
  if (o.status === "awaiting_customer_details") {
    await ctx.db.request(
      "bot_conversations?on_conflict=customer_id",
      "POST",
      { customer_id: c.id, step: "first_name", context: { order_id: o.id } },
      "resolution=merge-duplicates,return=representation",
    );
    await bot.send(
      c.bale_user_id,
      "پرداخت شما تأیید شد. لطفاً نام خود را وارد کنید.",
      [["بازگشت", "انصراف"]],
    );
    return;
  }
  if (o.status === "needs_review") {
    await bot.send(
      c.bale_user_id,
      `پرداخت و سفارش ${o.id} ثبت شده و نیازمند بررسی است. پرداخت مجدد انجام ندهید؛ نتیجه پس از بررسی همین‌جا اعلام می‌شود.`,
      MENU,
    );
    return;
  }
  if (o.status !== "completed") return;
  if (o.purpose === "wallet_probe") {
    await bot.send(
      c.bale_user_id,
      "اعتبارسنجی کیف پول با پرداخت و استعلام موفق انجام شد. این تراکنش صرفاً برای بررسی اتصال است و اشتراک صادر نمی‌کند.",
      MENU,
    );
    return;
  }
  if (o.mode === "test") {
    await bot.send(
      c.bale_user_id,
      "آزمایش پرداخت و تکمیل سفارش موفق بود. این سفارش آزمایشی است؛ توکن واقعی صادر نشده و اعتبار حساب واقعی تغییر نکرده است.",
      MENU,
    );
    return;
  }
  const sub = await ctx.db.one(
    "subscriptions",
    `id=eq.${o.subscription_id}&customer_id=eq.${c.id}`,
  );
  assert(sub, "NOT_OWNER", 403);
  const token = await ctx.decrypt(
    sub.token_ciphertext,
    "subscription:" + sub.gptyar_subscription_id,
  );
  assert(!token.startsWith("@"), "UNSAFE_SUBSCRIBER_TOKEN", 502);
  await bot.send(
    c.bale_user_id,
    `${o.intent === "renewal" ? "تمدید" : "صدور حساب"} موفق بود.\nتوکن اختصاصی شما:\n${token}\nمدت ${o.quantity} ${o.unit === "day" ? "روز" : "ماه"}\nانقضای واقعی: ${new Date(sub.expires_at).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}\nبرای فعال‌سازی، توکن را در افزونه GPT Yar وارد کنید.\nآموزش: ${(await ctx.setting("support")).site}`,
    MENU,
  );
}
