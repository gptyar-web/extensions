(() => {
  "use strict";
  const ui = window.GPTYAR_ADMIN_UI,
    req = ui.request,
    $ = (id) => document.getElementById(id),
    n = (tag, value, cls) => {
      const e = document.createElement(tag);
      if (value !== undefined) e.textContent = String(value);
      if (cls) e.className = cls;
      return e;
    };
  const fa = (v) => new Intl.NumberFormat("fa-IR").format(v),
    when = (v) =>
      v
        ? new Date(v).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
        : "—";
  const ERR = {
    RELEASE_CHANNEL_NOT_CONNECTED:
      "این بسته به کانال بروزرسانی همین سامانه متصل نیست. بسته سازگار را با ابزار مخزن chatgpt آماده کنید؛ نسخه اصلی API خود را تغییر نمی‌دهد.",
    WORKER_NOT_RUNNING:
      "پردازشگر پایدار هنوز اجرا نشده است؛ زمان‌بندی Supabase در راه‌اندازی اولیه باید فعال شود.",
    ADMIN_TOKEN_REQUIRED: "فقط توکن مدیریتی معتبر پذیرفته می‌شود.",
    ADMIN_NOT_CONFIRMED: "سطح مدیریت تأیید نشد.",
    ACCOUNT_NOT_ALLOWED:
      "این Backend برای حساب دیگری تنظیم شده یا شناسه حساب تنظیم نشده است.",
    GPTYAR_UNAUTHORIZED: "مجوز توکن در سرور GPT Yar رد شد.",
    GPTYAR_UPSTREAM_ERROR: "سرور GPT Yar در دسترس نیست یا درخواست را نپذیرفت.",
    GPTYAR_CONTRACT_MISMATCH:
      "پاسخ API با قرارداد نسخه ۴.۶.۵ سازگار نیست؛ نیاز به بررسی دارد.",
    CONNECTION_NOT_CONFIGURED: "اتصال موردنیاز هنوز تنظیم نشده است.",
    SESSION_EXPIRED: "نشست منقضی شده است؛ دوباره وارد شوید.",
    RATE_LIMITED: "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.",
    WRONG_BOT: "توکن باید متعلق به ربات @gpryarbot باشد.",
    WALLET_NOT_VERIFIED:
      "ابتدا پرداخت و استعلام اعتبارسنجی کیف پول را تکمیل کنید.",
    REQUEST_ALREADY_RECEIVED:
      "این درخواست قبلاً دریافت شده است؛ نتیجه را بررسی کنید.",
    STORAGE_ERROR: "ذخیره‌سازی فایل موفق نبود.",
    INVALID_PROVIDER_TOKEN: "توکن provider معتبر وارد کنید.",
    ENTERPRISE_USER_LIMIT: "ظرفیت مجاز مشترکان تکمیل است.",
    ENTERPRISE_EXPIRY_LIMIT: "تاریخ انقضا خارج از محدودیت سرور است.",
    LIMITS_NOT_VERIFIED: "محدودیت‌های واقعی حساب هنوز تأیید نشده‌اند.",
    MANIFEST_VERSION_MISMATCH: "نسخه واردشده با Manifest بسته یکسان نیست.",
    ZIP_REQUIRED: "بسته افزونه باید ZIP باشد.",
    OWNERSHIP_EVIDENCE_REQUIRED: "تأیید سابقه مالکیت الزامی است.",
  };
  const labels = {
    pending_payment: "در انتظار پرداخت",
    paid: "پرداخت تأییدشده",
    awaiting_customer_details: "در انتظار نام مشتری",
    provisioning: "در حال صدور",
    completed: "تکمیل‌شده",
    failed: "ناموفق",
    needs_review: "نیازمند رسیدگی",
    cancelled: "لغوشده",
    pending: "در انتظار",
    rejected: "ردشده",
    refund_required: "نیازمند بازپرداخت",
    refunded: "بازپرداخت ثبت‌شده",
    purchase: "خرید",
    renewal: "تمدید",
    test: "آزمایشی",
    live: "واقعی",
    day: "روز",
    month: "ماه",
    wallet_probe: "اعتبارسنجی کیف پول",
    sale: "فروش",
  };
  let active = "overview",
    loadId = 0;
  function error(code) {
    return ERR[code] || code;
  }
  function button(host, label, fn, danger = false) {
    const b = n(
      "button",
      label,
      "button " + (danger ? "danger-outline" : "secondary"),
    );
    b.type = "button";
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        ui.toast(e.message, true);
      } finally {
        b.disabled = false;
      }
    });
    host.append(b);
    return b;
  }
  function title(host, label, description) {
    host.replaceChildren(n("h2", label));
    if (description) host.append(n("p", description, "muted"));
  }
  function state(host, value) {
    host.append(n("div", value, "commerce-state"));
  }
  function field(form, key, label, type = "text", value = "", options) {
    const wrap = n("label", label, type === "checkbox" ? "check" : "");
    let input;
    if (type === "select") {
      input = n("select");
      for (const [v, t] of options) {
        const o = n("option", t);
        o.value = v;
        input.append(o);
      }
    } else input = n(type === "textarea" ? "textarea" : "input");
    input.name = key;
    input.id = "f-" + active + "-" + key + "-" + crypto.randomUUID();
    if (type !== "textarea" && type !== "select") input.type = type;
    if (type === "checkbox") input.checked = !!value;
    else if (type !== "file") input.value = value ?? "";
    if (type === "password") {
      input.autocomplete = "new-password";
      input.dir = "ltr";
      input.spellcheck = false;
    }
    if (type === "number") {
      input.step = "1";
      input.min = "0";
    }
    if (type === "file" && options) input.accept = options;
    wrap.append(input);
    form.append(wrap);
    return input;
  }
  function form(host, submitLabel, fn) {
    const f = n("form", undefined, "commerce-form"),
      actions = n("div", undefined, "form-actions"),
      submit = n("button", submitLabel, "button primary");
    submit.type = "submit";
    actions.append(submit);
    host.append(f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await fn(f);
      } catch (err) {
        ui.toast(err.message, true);
      } finally {
        submit.disabled = false;
      }
    });
    f.finish = () => f.append(actions);
    return f;
  }
  const val = (f, k) => f.elements.namedItem(k).value,
    checked = (f, k) => f.elements.namedItem(k).checked,
    num = (f, k) => Number(val(f, k)),
    nullable = (f, k) => (val(f, k) === "" ? null : num(f, k));
  const post = (path, body) => req(path, { method: "POST", body });
  function table(host, columns, rows, action) {
    const wrap = n("div", undefined, "table-wrap"),
      t = n("table"),
      head = n("tr");
    for (const c of columns) head.append(n("th", c[0]));
    if (action) head.append(n("th", "عملیات"));
    const th = n("thead");
    th.append(head);
    t.append(th);
    const body = n("tbody");
    if (!rows.length) {
      const r = n("tr"),
        td = n("td", "داده‌ای ثبت نشده است.", "empty");
      td.colSpan = columns.length + !!action;
      r.append(td);
      body.append(r);
    }
    for (const row of rows) {
      const tr = n("tr");
      for (const [, read] of columns) {
        const value = read(row);
        tr.append(n("td", value == null ? "—" : String(value)));
      }
      if (action) {
        const td = n("td");
        action(td, row);
        tr.append(td);
      }
      body.append(tr);
    }
    t.append(body);
    wrap.append(t);
    host.append(wrap);
  }
  async function dashboard(host, reports = false) {
    const data = await req("/api/dashboard"),
      m = data.metrics;
    host.replaceChildren();
    const names = {
      customers: "مشتریان بله",
      active: "اشتراک فعال ربات",
      expired: "اشتراک منقضی ربات",
      orders_today: "سفارش امروز",
      successful: "پرداخت موفق واقعی",
      failed: "پرداخت ناموفق",
      sales: "فروش کل (ریال)",
      daily: "درآمد امروز (ریال)",
      monthly: "درآمد این ماه میلادی (ریال)",
      renewals: "تمدید تکمیل‌شده",
      tokens: "توکن واقعی صادرشده",
      pending: "سفارش در انتظار",
      needs_review: "نیازمند رسیدگی",
    };
    const grid = reports ? n("div", undefined, "stats") : host;
    if (reports)
      host.append(
        n("h2", "گزارش واقعی فروش"),
        n(
          "p",
          "مبالغ فروش فقط از پرداخت‌های واقعی تأییدشده محاسبه می‌شوند؛ پرداخت آزمایشی در درآمد نیست. روزها با منطقه زمانی تهران محاسبه می‌شوند.",
        ),
        grid,
      );
    for (const [key, label] of Object.entries(names)) {
      const card = n("article", undefined, "stat");
      card.append(n("span", label), n("strong", fa(m[key])));
      grid.append(card);
    }
    const c = data.connections;
    grid.append(
      n(
        "div",
        `API GPT Yar: ${c.gptyar.connected ? "متصل" : "قطع"} · ربات: ${c.bot.connected ? "متصل" : "تأییدنشده"} · فعالیت ربات: ${c.bot.enabled ? "فعال" : "غیرفعال"} · کیف پول: ${c.wallet.verified ? "تأیید واقعی" : c.wallet.test_verified ? "آزمایش تأییدشده" : "تأییدنشده"} · حالت: ${labels[c.wallet.mode]}`,
        "connection-box",
      ),
    );
  }
  async function settingsData() {
    return req("/api/settings");
  }
  async function botPage(host) {
    const { settings } = await settingsData(),
      b = settings.bot;
    title(
      host,
      "تنظیمات ربات بله",
      "توکن به شکل رمزنگاری‌شده در Backend نگهداری می‌شود. پس از ذخیره، مقدار کامل قابل دریافت نیست.",
    );
    state(
      host,
      `ربات: ${b.username ? "@" + b.username : "ثبت نشده"}\nنام: ${b.name || "—"}\nاتصال: ${b.connected ? "تأییدشده" : "تأییدنشده"}\nفعالیت: ${b.enabled ? "فعال" : "غیرفعال"}\nWebhook: ${b.webhook_registered ? "ثبت و بررسی شده" : "تأییدنشده"}\nآخرین بررسی: ${when(b.checked_at)}`,
    );
    const f = form(host, "ذخیره امن و ثبت Webhook", async (f) => {
      await post("/api/settings/bot", { token: val(f, "token") });
      f.reset();
      await load("bot");
    });
    field(f, "token", "توکن API ربات @gpryarbot", "password");
    f.finish();
    const tools = n("div", undefined, "tools");
    host.append(tools);
    button(tools, "بررسی اتصال", async () => {
      await post("/api/settings/bot/check", {});
      await load("bot");
    });
    button(
      tools,
      b.enabled ? "غیرفعال‌سازی ربات" : "فعال‌سازی ربات",
      async () => {
        await post("/api/settings/bot/toggle", { enabled: !b.enabled });
        await load("bot");
      },
    );
  }
  async function walletPage(host) {
    const { settings } = await settingsData(),
      w = settings.wallet;
    title(
      host,
      "تنظیمات پرداخت بله",
      "توکن provider_token با توکن API ربات متفاوت است. بله متد رسمی مستقلی برای بررسی توکن پرداخت ندارد؛ اتصال با صورتحساب و استعلام پرداخت بررسی می‌شود.",
    );
    state(
      host,
      `حالت: ${labels[w.mode]}\nپرداخت عمومی: ${w.enabled ? "فعال" : "غیرفعال"}\nتأیید پرداخت واقعی: ${w.verified ? "بله" : "خیر"}\nتأیید آزمایش: ${w.test_verified ? "بله" : "خیر"}\nآخرین تأیید: ${when(w.last_verified_at || w.test_verified_at)}`,
    );
    const f = form(host, "ذخیره امن تنظیمات", async (f) => {
      await post("/api/settings/wallet", {
        mode: val(f, "mode"),
        token: val(f, "token"),
        confirm: checked(f, "confirm"),
      });
      f.reset();
      await load("wallet");
    });
    field(f, "mode", "حالت پرداخت", "select", w.mode, [
      ["test", "آزمایشی؛ بدون انتقال وجه"],
      ["live", "واقعی"],
    ]);
    field(f, "token", "توکن پرداخت کیف پول (فقط برای حالت واقعی)", "password");
    field(f, "confirm", "تنظیم توکن و حالت واقعی را تأیید می‌کنم.", "checkbox");
    f.finish();
    host.append(n("h3", "اعتبارسنجی با صورتحساب رسمی"));
    const probe = form(host, "صدور صورتحساب اعتبارسنجی", async (f) => {
      await post("/api/settings/wallet/probe", {
        bale_user_id: val(f, "user"),
        confirm: checked(f, "confirm"),
      });
      ui.toast(
        "صورتحساب به گفت‌وگوی خصوصی ارسال شد. پس از پرداخت و استعلام، وضعیت اتصال تأیید می‌شود.",
      );
    });
    field(
      probe,
      "user",
      "شناسه عددی بله مدیر؛ ابتدا /start را به ربات بفرستید",
    );
    field(
      probe,
      "confirm",
      "صدور صورتحساب ۱۰۰۰ ریالی را تأیید می‌کنم؛ در حالت واقعی این مبلغ پرداخت می‌شود. این آزمایش اشتراک صادر نمی‌کند.",
      "checkbox",
    );
    probe.finish();
    button(
      host,
      w.enabled ? "غیرفعال‌سازی پرداخت" : "فعال‌سازی پرداخت",
      async () => {
        await post("/api/settings/wallet/toggle", { enabled: !w.enabled });
        await load("wallet");
      },
    );
    button(host, "بروزرسانی وضعیت", () => load("wallet"));
  }
  async function systemPage(host) {
    const d = await settingsData(),
      s = d.settings;
    title(
      host,
      "تنظیمات سامانه",
      "مجوز خودکار ربات مستقل از نشست مرورگر است. ذخیره آن فقط با تأیید صریح شما و به شکل AES-GCM در Backend انجام می‌شود. کلید رمزنگاری خارج از دیتابیس است.",
    );
    state(
      host,
      `مجوز خودکار: ${d.secrets.some((x) => x.key === "gptyar_automation") ? "ذخیره شده؛ مقدار مخفی" : "ذخیره نشده"}\nنسخه قرارداد API: ${d.extension_version}`,
    );
    const f = form(host, "ذخیره مجوز همین مدیر برای ربات", async (f) => {
      await post("/api/settings/automation", {
        consent: checked(f, "consent"),
      });
      await load("settings");
    });
    field(
      f,
      "consent",
      "اجازه می‌دهم مجوز مدیریتی این نشست برای صدور و تمدید خودکار، رمزنگاری و سمت سرور نگهداری شود.",
      "checkbox",
    );
    f.finish();
    button(
      host,
      "ابطال مجوز خودکار",
      async () => {
        await post("/api/settings/automation", { revoke: true });
        await load("settings");
      },
      true,
    );
    button(host, "ابطال سایر نشست‌ها", async () => {
      await post("/api/sessions/revoke", {});
      ui.toast("سایر نشست‌ها باطل شدند.");
    });
    host.append(n("h3", "اعلان مدیریتی در بله"));
    state(
      host,
      s.notifications?.enabled
        ? "اعلان‌ها برای گفت‌وگوی خصوصی تأییدشده فعال است."
        : "اعلان خصوصی متصل نیست؛ خطاها در پنل ثبت می‌شوند.",
    );
    button(host, "اتصال گفت‌وگوی خصوصی مدیر", async () => {
      const result = await post("/api/settings/notifications/pair", {});
      const link = n("a", "باز کردن پیوند یک‌بارمصرف در بله", "button primary");
      link.href = result.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      host.append(link);
      ui.toast("این پیوند را خودتان باز کنید؛ تا ۱۵ دقیقه معتبر است.");
    });
    button(host, "غیرفعال‌سازی اعلان بله", async () => {
      await post("/api/settings/notifications/disable", {});
      await load("settings");
    });
    host.append(n("h3", "محدودیت واقعی حساب"));
    host.append(
      n(
        "p",
        "اولویت با limits پاسخ سرور است. اگر سرور مقدار را برنمی‌گرداند، تنها پس از تأیید محدودیت واقعی با ارائه‌دهنده مقدار وارد کنید. خالی به معنی نامحدودِ تأییدشده است. پیش‌فرض ۲۰ کاربر یا ۶۰ روز فرض نمی‌شود.",
        "muted",
      ),
    );
    const l = s.limits || {},
      lf = form(host, "ثبت محدودیت‌های تأییدشده", async (f) => {
        await post("/api/settings/limits", {
          confirmed: checked(f, "confirmed"),
          maxUsers: nullable(f, "users"),
          maxDurationDays: nullable(f, "days"),
          maxExpiresAt: val(f, "expiry")
            ? new Date(val(f, "expiry")).toISOString()
            : null,
        });
        await load("settings");
      });
    field(lf, "users", "سقف کاربران؛ خالی برای نامحدود", "number", l.maxUsers);
    field(
      lf,
      "days",
      "حداکثر روز از امروز؛ خالی برای نامحدود",
      "number",
      l.maxDurationDays,
    );
    field(
      lf,
      "expiry",
      "آخرین تاریخ مجاز انقضا (اختیاری)",
      "datetime-local",
      l.maxExpiresAt ? l.maxExpiresAt.slice(0, 16) : "",
    );
    field(
      lf,
      "confirmed",
      "این محدودیت‌ها را با قرارداد یا پاسخ واقعی سرور بررسی کرده‌ام.",
      "checkbox",
      l.confirmed,
    );
    lf.finish();
    host.append(n("h3", "پشتیبانی و راهنمای ربات"));
    const sf = form(host, "ذخیره مسیرها", async (f) => {
      await post("/api/settings/support", {
        url: val(f, "url"),
        site: val(f, "site"),
      });
      ui.toast("ذخیره شد.");
    });
    field(sf, "url", "پیوند HTTPS پشتیبانی", "url", s.support.url);
    field(sf, "site", "نشانی HTTPS سایت و آموزش", "url", s.support.site);
    sf.finish();
  }
  async function pricingPage(host) {
    title(
      host,
      "مدیریت قیمت‌ها",
      "تمام قیمت‌ها به ریال هستند. هر ماه ۳۰ روز است. قیمت ثبت‌شده در صورتحساب تا پایان اعتبار آن ثابت می‌ماند.",
    );
    for (const r of await req("/api/pricing")) {
      host.append(n("h3", r.unit === "day" ? "تعرفه روزانه" : "تعرفه ماهانه"));
      const f = form(host, "ذخیره تعرفه", async (f) => {
        await post("/api/pricing", {
          unit: r.unit,
          unit_price_rial: num(f, "price"),
          min_quantity: num(f, "min"),
          max_quantity: num(f, "max"),
          enabled: checked(f, "enabled"),
        });
        ui.toast("تعرفه مشترک سایت و ربات بروزرسانی شد.");
      });
      field(f, "price", "قیمت هر واحد به ریال", "number", r.unit_price_rial);
      field(f, "min", "حداقل تعداد", "number", r.min_quantity);
      field(f, "max", "حداکثر تعداد", "number", r.max_quantity);
      field(f, "enabled", "فروش فعال باشد", "checkbox", r.enabled);
      f.finish();
    }
  }
  async function ordersPage(host, page, offset = 0, q = "", status = "") {
    title(
      host,
      page === "renewals" ? "مدیریت تمدیدها" : "مدیریت سفارش‌ها",
      "رسید پرداخت، وضعیت صدور و سفارش‌های نیازمند رسیدگی حفظ می‌شوند. تلاش مجدد ابتدا وضعیت واقعی سرور را تطبیق می‌دهد.",
    );
    const f = form(host, "جست‌وجو", async (f) =>
      ordersPage(host, page, 0, val(f, "q"), val(f, "status")),
    );
    field(f, "q", "نام مشتری، شناسه سفارش یا شناسه بله", "search", q);
    field(f, "status", "وضعیت", "select", status, [
      ["", "همه وضعیت‌ها"],
      ...Object.keys(labels)
        .filter((k) =>
          [
            "pending_payment",
            "paid",
            "awaiting_customer_details",
            "provisioning",
            "completed",
            "failed",
            "needs_review",
            "cancelled",
          ].includes(k),
        )
        .map((k) => [k, labels[k]]),
    ]);
    f.finish();
    const rows = await req(
      `/api/${page}?offset=${offset}&q=${encodeURIComponent(q)}&status=${status}`,
    );
    table(
      host,
      [
        ["سفارش", (r) => r.id],
        [
          "مشتری",
          (r) =>
            [
              r.first_name || r.bot_customers?.first_name,
              r.last_name || r.bot_customers?.last_name,
            ]
              .filter(Boolean)
              .join(" "),
        ],
        ["شناسه بله", (r) => r.bot_customers?.bale_user_id],
        [
          "نوع و مدت",
          (r) =>
            `${labels[r.intent]} ${fa(r.quantity)} ${labels[r.unit]} · ${labels[r.mode]} · ${labels[r.purpose]}`,
        ],
        [
          "اولیه / تخفیف / نهایی (ریال)",
          (r) =>
            [r.subtotal_rial, r.discount_rial, r.total_rial]
              .map(fa)
              .join(" / "),
        ],
        ["وضعیت پرداخت", (r) => labels[r.payments?.[0]?.status] || "—"],
        ["شناسه تراکنش", (r) => r.payments?.[0]?.bale_charge_id],
        ["وضعیت سفارش", (r) => labels[r.status]],
        ["تاریخ", (r) => when(r.created_at)],
        ["انقضا", (r) => when(r.subscriptions?.expires_at)],
        ["خطا", (r) => error(r.error_code) || "—"],
      ],
      rows,
      (td, r) => {
        if (r.status === "needs_review") {
          button(td, "تطبیق و تلاش امن", async () => {
            await post("/api/orders/retry", { id: r.id });
            ui.toast("در صف قرار گرفت.");
          });
          button(td, "ثبت بازپرداخت انجام‌شده", async () => {
            const reference = prompt(
              "شناسه پیگیری بازپرداختی که واقعاً توسط پشتیبانی بله انجام شده است:",
            );
            if (reference) {
              await post("/api/orders/refund", { id: r.id, reference });
              await ordersPage(host, page, offset, q, status);
            }
          });
        }
      },
    );
    const tools = n("div", undefined, "tools");
    host.append(tools);
    if (offset)
      button(tools, "صفحه قبلی", () =>
        ordersPage(host, page, Math.max(0, offset - 100), q, status),
      );
    if (rows.length === 100)
      button(tools, "صفحه بعدی", () =>
        ordersPage(host, page, offset + 100, q, status),
      );
  }
  async function discountsPage(host) {
    title(
      host,
      "کدهای تخفیف",
      "سقف استفاده و رزرو کدها در تراکنش دیتابیس کنترل می‌شود. کدهای قبلی بایگانی می‌شوند تا سابقه فروش از بین نرود.",
    );
    const rows = await req("/api/discounts");
    table(
      host,
      [
        ["کد", (r) => r.code],
        [
          "مقدار",
          (r) => `${fa(r.value)} ${r.kind === "percent" ? "درصد" : "ریال"}`,
        ],
        [
          "کاربرد",
          (r) => (r.scope === "both" ? "خرید و تمدید" : labels[r.scope]),
        ],
        ["شروع / پایان", (r) => when(r.starts_at) + " / " + when(r.ends_at)],
        [
          "وضعیت",
          (r) => (r.archived ? "بایگانی" : r.active ? "فعال" : "غیرفعال"),
        ],
      ],
      rows,
      (td, r) => button(td, "ویرایش", () => edit(r)),
    );
    const editor = n("div");
    host.append(editor);
    function edit(r = {}) {
      editor.replaceChildren(n("h3", r.id ? "ویرایش کد" : "کد جدید"));
      const f = form(editor, "ذخیره کد", async (f) => {
        await post("/api/discounts", {
          id: r.id,
          code: val(f, "code"),
          kind: val(f, "kind"),
          value: num(f, "value"),
          scope: val(f, "scope"),
          starts_at: new Date(val(f, "starts")).toISOString(),
          ends_at: val(f, "ends")
            ? new Date(val(f, "ends")).toISOString()
            : null,
          max_uses: nullable(f, "max"),
          per_customer: num(f, "per"),
          active: checked(f, "active"),
          archived: checked(f, "archived"),
        });
        await load("discounts");
      });
      field(f, "code", "کد لاتین", "text", r.code || "");
      field(f, "kind", "نوع تخفیف", "select", r.kind || "percent", [
        ["percent", "درصدی"],
        ["fixed", "مبلغ ثابت ریالی"],
      ]);
      field(f, "value", "مقدار", "number", r.value || 10);
      field(f, "scope", "کاربرد", "select", r.scope || "both", [
        ["both", "خرید و تمدید"],
        ["purchase", "خرید"],
        ["renewal", "تمدید"],
      ]);
      field(
        f,
        "starts",
        "شروع (زمان مرورگر)",
        "datetime-local",
        (r.starts_at || new Date().toISOString()).slice(0, 16),
      );
      field(
        f,
        "ends",
        "پایان (زمان مرورگر)",
        "datetime-local",
        r.ends_at?.slice(0, 16) || "",
      );
      field(
        f,
        "max",
        "سقف کل استفاده؛ خالی برای نامحدود",
        "number",
        r.max_uses,
      );
      field(f, "per", "سقف هر مشتری", "number", r.per_customer || 1);
      field(f, "active", "فعال", "checkbox", r.active ?? true);
      field(f, "archived", "بایگانی / حذف از فروش", "checkbox", r.archived);
      f.finish();
    }
    edit();
  }
  async function upload(file, kind) {
    const signed = await post("/api/uploads", {
      kind,
      mime: file.type,
      size: file.size,
    });
    const r = await fetch(signed.url, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!r.ok) throw new Error("بارگذاری فایل انجام نشد.");
    return signed.path;
  }
  async function videosPage(host) {
    title(
      host,
      "فیلم‌های آموزشی",
      "فایل‌های دارای مجوز را بارگذاری کنید. پخش داخل سایت با پلیر HTML5 و Storage انجام می‌شود. فایل قبلی تا جایگزینی موفق نگهداری می‌شود.",
    );
    const rows = await req("/api/videos");
    table(
      host,
      [
        ["عنوان", (r) => r.title],
        ["شناسه", (r) => r.slug],
        ["ترتیب", (r) => r.sort_order],
        ["وضعیت", (r) => (r.active ? "فعال" : "غیرفعال")],
      ],
      rows,
      (td, r) => button(td, "ویرایش / جایگزینی", () => edit(r)),
    );
    const editor = n("div");
    host.append(editor);
    function edit(r = {}) {
      editor.replaceChildren(n("h3", r.id ? "ویرایش آموزش" : "آموزش جدید"));
      const f = form(editor, "بارگذاری و ذخیره", async (f) => {
        const video = f.elements.video.files[0],
          poster = f.elements.poster.files[0];
        await post("/api/videos", {
          id: r.id,
          slug: val(f, "slug"),
          title: val(f, "title"),
          description: val(f, "description"),
          sort_order: num(f, "sort"),
          active: checked(f, "active"),
          storage_path: video ? await upload(video, "video") : r.storage_path,
          poster_path: poster ? await upload(poster, "poster") : r.poster_path,
        });
        await load("videos");
      });
      field(f, "slug", "شناسه لاتین", "text", r.slug || "");
      field(f, "title", "عنوان", "text", r.title || "");
      field(f, "description", "توضیحات", "textarea", r.description || "");
      field(f, "sort", "ترتیب", "number", r.sort_order || 0);
      field(
        f,
        "video",
        "فیلم MP4 یا WebM؛ حداکثر ۵۰۰ مگابایت",
        "file",
        "",
        "video/mp4,video/webm",
      );
      field(
        f,
        "poster",
        "تصویر پیش‌نمایش؛ حداکثر ۵ مگابایت",
        "file",
        "",
        "image/png,image/jpeg,image/webp",
      );
      field(f, "active", "فعال و قابل نمایش در سایت", "checkbox", r.active);
      f.finish();
    }
    edit();
  }
  async function releasesPage(host) {
    const d = await settingsData();
    title(
      host,
      "مدیریت نسخه‌های افزونه",
      "بسته ZIP با Manifest نسخه ۳ پذیرفته می‌شود. حجم، ساختار و نسخه در Backend بررسی و SHA-256 نگهداری می‌شود. نصب افزونه در Chrome همچنان دستی است.",
    );
    state(
      host,
      "مسیر بررسی نسخه در افزونه سازگار:\n" +
        d.update_endpoint +
        "\nافزونه اصلی ۴.۶.۵ همچنان API اصلی را می‌خواند؛ انتشار اینجا فقط روی نسخه‌ای اثر دارد که به این مسیر متصل شده باشد.",
    );
    const f = form(host, "آپلود و بررسی بسته", async (f) => {
      const file = f.elements.file.files[0];
      if (!file || file.size > 20 * 1024 * 1024)
        throw new Error("یک فایل ZIP تا ۲۰ مگابایت انتخاب کنید.");
      const r = await fetch(
        ui.base +
          "/api/releases/upload?version=" +
          encodeURIComponent(val(f, "version")),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + ui.session(),
            "X-Request-ID": crypto.randomUUID(),
            "Content-Type": "application/zip",
          },
          body: file,
        },
      );
      const out = await r.json();
      if (!r.ok) throw new Error(error(out.error));
      await load("releases");
    });
    field(f, "version", "نسخه دقیق Manifest");
    field(f, "file", "بسته ZIP", "file", "", ".zip");
    f.finish();
    const rows = await req("/api/releases");
    table(
      host,
      [
        ["نسخه", (r) => r.version],
        ["وضعیت", (r) => (r.published ? "منتشرشده" : "نگهداری‌شده / پیش‌نویس")],
        ["روش", (r) => (r.update_mode === "FORCED" ? "اجباری" : "اختیاری")],
        ["SHA-256", (r) => r.sha256],
        ["تاریخ", (r) => when(r.published_at)],
      ],
      rows,
      (td, r) => {
        button(td, "ویرایش جزئیات", () => edit(r));
        button(td, "انتشار", async () => {
          if (confirm("نسخه " + r.version + " منتشر شود؟")) {
            await post("/api/releases/publish", { id: r.id, rollback: false });
            await load("releases");
          }
        });
        button(td, "بازگشت به این نسخه", async () => {
          if (confirm("بازگشت اجباری برای کاربران نسخه جدیدتر فعال شود؟")) {
            await post("/api/releases/publish", { id: r.id, rollback: true });
            await load("releases");
          }
        });
      },
    );
    const editor = n("div");
    host.append(editor);
    function edit(r) {
      editor.replaceChildren();
      const f = form(editor, "ذخیره جزئیات نسخه", async (f) => {
        await post("/api/releases", {
          id: r.id,
          changelog: val(f, "changelog"),
          update_mode: val(f, "mode"),
          download_link: val(f, "link") || null,
        });
        await load("releases");
      });
      field(f, "changelog", "توضیحات بروزرسانی", "textarea", r.changelog);
      field(f, "mode", "نوع بروزرسانی", "select", r.update_mode, [
        ["OPTIONAL", "اختیاری"],
        ["FORCED", "اجباری در افزونه متصل به این مسیر"],
      ]);
      field(
        f,
        "link",
        "لینک دانلود HTTPS اختیاری؛ فایل باید با هش بسته برابر باشد",
        "url",
        r.download_link || "",
      );
      f.finish();
    }
  }
  async function claims(host) {
    host.append(n("h3", "درخواست اتصال اشتراک قدیمی"));
    const rows = await req("/api/claims");
    table(
      host,
      [
        ["شناسه درخواست", (r) => r.id],
        ["شناسه بله", (r) => r.bot_customers?.bale_user_id],
        ["وضعیت", (r) => r.status],
        ["زمان", (r) => when(r.created_at)],
      ],
      rows,
      (td, r) => {
        if (r.status === "pending") {
          button(td, "تأیید پس از احراز مالکیت", async () => {
            if (
              confirm(
                "سابقه خرید و هویت این مشتری را مستقلاً تأیید کرده‌اید؟ داشتن توکن به‌تنهایی اثبات مالکیت نیست.",
              )
            ) {
              await post("/api/claims/review", {
                id: r.id,
                approve: true,
                ownership_verified: true,
              });
              await load("renewals");
            }
          });
          button(td, "رد", async () => {
            await post("/api/claims/review", { id: r.id, approve: false });
            await load("renewals");
          });
        }
      },
    );
  }
  async function load(page) {
    active = page;
    const sequence = ++loadId;
    try {
      if (page === "overview") {
        await dashboard($("commerceDashboard"));
        return;
      }
      const host = $("commerce-" + page);
      if (!host) return;
      host.replaceChildren(n("p", "در حال دریافت داده‌های واقعی…"));
      if (page === "bot") await botPage(host);
      else if (page === "wallet") await walletPage(host);
      else if (page === "settings") await systemPage(host);
      else if (page === "pricing") await pricingPage(host);
      else if (page === "orders" || page === "renewals") {
        await ordersPage(host, page);
        if (page === "renewals") await claims(host);
      } else if (page === "discounts") await discountsPage(host);
      else if (page === "videos") await videosPage(host);
      else if (page === "releases") await releasesPage(host);
      else if (page === "reports") await dashboard(host, true);
      else if (page === "payments") {
        title(
          host,
          "پرداخت‌ها",
          "بازپرداخت تنها پس از انجام واقعی توسط پشتیبانی بله و با شناسه پیگیری ثبت می‌شود. این پنل متد بازپرداختِ مستندنشده فراخوانی نمی‌کند.",
        );
        const rows = await req("/api/payments");
        table(
          host,
          [
            ["سفارش", (r) => r.order_id],
            ["تراکنش", (r) => r.bale_charge_id],
            ["پیگیری", (r) => r.provider_charge_id],
            ["مبلغ ریال", (r) => fa(r.amount_rial)],
            ["پرداخت‌کننده", (r) => r.payer_bale_id],
            ["وضعیت", (r) => labels[r.status]],
            ["حالت", (r) => labels[r.mode]],
            ["تأیید", (r) => when(r.verified_at)],
          ],
          rows,
        );
      } else if (page === "logs") {
        title(
          host,
          "گزارش عملیات و خطاها",
          "توکن‌ها و متن محرمانه در این گزارش ثبت نمی‌شوند.",
        );
        table(
          host,
          [
            ["عملیات", (r) => r.action],
            ["هدف", (r) => r.target_id],
            ["زمان", (r) => when(r.created_at)],
          ],
          await req("/api/logs"),
        );
        host.append(n("h3", "رسیدهای پرداخت نیازمند بررسی"));
        table(
          host,
          [
            ["شناسه تراکنش", (r) => r.charge_id],
            ["پرداخت‌کننده", (r) => r.payer_bale_id],
            ["خطا", (r) => error(r.error_code)],
          ],
          await req("/api/receipts"),
        );
        host.append(n("h3", "رویدادهای نیازمند بررسی"));
        table(
          host,
          [
            ["رویداد", (r) => error(r.event_code)],
            ["سفارش", (r) => r.order_id],
            ["زمان", (r) => when(r.created_at)],
          ],
          await req("/api/events"),
        );
      }
    } catch (e) {
      if (sequence === loadId) {
        ui.toast(e.message, true);
        const host = $("commerce-" + page);
        if (host) host.replaceChildren(n("p", e.message, "field-error"));
      }
    }
  }
  window.GPTYAR_COMMERCE = {
    load,
    error,
    clear() {
      document
        .querySelectorAll(".commerce-host")
        .forEach((x) => x.replaceChildren());
      $("commerceDashboard").replaceChildren();
    },
  };
  $("refreshBtn").addEventListener("click", () => load(active));
})();
