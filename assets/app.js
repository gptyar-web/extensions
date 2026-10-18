(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = String(window.ADMIN_PANEL_CONFIG?.API_BASE_URL || '').trim().replace(/\/+$/, '');
  const pages = { overview: 'نمای کلی', subscribers: 'مدیریت مشترکان', cookies: 'مدیریت کوکی‌ها', proxies: 'پروکسی‌ها', account: 'اطلاعات حساب و MFA', help: 'راهنما و محدودیت‌ها', bot:'تنظیمات ربات بله', wallet:'تنظیمات پرداخت بله', orders:'سفارش‌ها', payments:'پرداخت‌ها', renewals:'تمدید اشتراک', discounts:'کدهای تخفیف', pricing:'مدیریت قیمت‌ها', videos:'فیلم‌های آموزشی', releases:'نسخه‌های افزونه', settings:'تنظیمات سامانه', reports:'گزارش فروش', logs:'گزارش عملیات و خطاها' };
  const state = { token: '', profile: null, subscribers: [], expiryId: '', busy: false, otpTimer: null };
  const text = x => typeof x === 'string' ? x : (x == null ? '' : String(x));
  const safe = x => text(x).slice(0, 600);
  const formatDate = x => {
    if (!x) return '—';
    const date = new Date(x);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('fa-IR');
  };
  const isoDate = value => value ? `${value}T23:59:59.000Z` : undefined;
  let toastId;
  function toast(message, isError = false) {
    const el = $('toast'); el.textContent = message; el.hidden = false; el.classList.toggle('error', isError);
    clearTimeout(toastId); toastId = setTimeout(() => el.hidden = true, 5000);
  }
  function configured() { try { const u=new URL(base); return u.protocol==='https:' && !u.search && !u.hash; } catch { return false; } }
  async function request(path, options = {}) {
    if (!configured()) throw new Error('نشانی HTTPS سرویس Supabase در config.js تنظیم نشده است.');
    const token = options.token ?? state.token;
    const res = await fetch(base + path, {
      method: options.method || 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...((options.method && options.method!=='GET') ? {'X-Request-ID':crypto.randomUUID()} : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { signOut(); throw new Error('اعتبار توکن مدیریتی تأیید نشد. لطفاً دوباره وارد شوید.'); }
    if (!res.ok) throw new Error(window.GPTYAR_COMMERCE?.error(data.error) || data.error || `خطای سرور (${res.status})`);
    return data;
  }
  function setScreen(loggedIn) {
    $('loginScreen').hidden = loggedIn;
    $('dashboard').hidden = !loggedIn;
    $('connectionLabel').textContent = loggedIn ? 'مدیر تأیید شد' : 'در انتظار ورود مدیر';
    document.querySelector('.status-dot').classList.toggle('on', loggedIn);
  }
  function clearOtp() { if (state.otpTimer) clearInterval(state.otpTimer); state.otpTimer = null; }
  function signOut() {
    state.token = ''; state.profile = null; state.subscribers = []; state.expiryId = ''; clearOtp();
    $('adminToken').value = ''; $('cookieJson').value = '';
    $('resultText').value = '';
    document.querySelectorAll('dialog[open]').forEach(x => x.close());
    window.GPTYAR_COMMERCE?.clear();
    setScreen(false);
  }
  function navigate(page) {
    if (!pages[page] || !state.token) return;
    Object.keys(pages).forEach(k => $('page-' + k).hidden = k !== page);
    document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    $('pageTitle').textContent = pages[page];
    if (page === 'subscribers') loadSubscribers();
    if (page === 'account') renderAccount();
    window.GPTYAR_COMMERCE?.load(page);
  }
  function el(type, cls, value) { const n = document.createElement(type); if (cls) n.className = cls; if (value !== undefined) n.textContent = text(value); return n; }
  function addButton(parent, value, handler, danger = false) {
    const b = el('button', danger ? 'mini danger' : 'mini', value); b.type = 'button'; b.addEventListener('click', handler); parent.append(b); return b;
  }
  function showResult(data) {
    const raw = (data && typeof data === 'object') ? JSON.stringify(data, null, 2) : safe(data);
    $('resultText').value = raw; $('resultDialog').showModal();
  }
  function asSubscribers(data) { return Array.isArray(data?.subscribers) ? data.subscribers : Array.isArray(data) ? data : []; }
  function idOf(s) { return text(s.subscriptionId ?? s.id); }
  function filterSubscribers() {
    const q = $('subscriberSearch').value.trim().toLocaleLowerCase();
    const found = state.subscribers.filter(s => `${s.name || ''} ${s.token || ''}`.toLocaleLowerCase().includes(q));
    const body = $('subscribersBody'); body.replaceChildren();
    if (!found.length) { const tr = el('tr'); const cell = el('td', 'empty', 'مشترکی یافت نشد.'); cell.colSpan = 5; tr.append(cell); body.append(tr); return; }
    for (const s of found) {
      const tr = el('tr'); const name = el('td', '', safe(s.name || 'بدون نام')); const tok = el('td', 'table-token', safe(s.token || '—'));
      const exp = el('td', '', formatDate(s.expiresAt));
      const active = s.isActive !== false && (!s.expiresAt || Date.parse(s.expiresAt) > Date.now());
      const status = el('td'); status.append(el('span', `tag ${active ? 'good' : 'bad'}`, active ? 'فعال' : 'غیرفعال / منقضی'));
      const action = el('td'); const actions = el('div', 'row-actions'); const id = idOf(s);
      addButton(actions, 'انقضا', () => { state.expiryId = id; $('expiryName').textContent = safe(s.name); $('expiryValue').value = s.expiresAt ? s.expiresAt.slice(0, 10) : ''; $('expiryDialog').showModal(); });
      addButton(actions, 'حذف', async () => {
        if (!confirm(`مشترک «${safe(s.name)}» حذف شود؟ این کار قابل بازگشت نیست.`)) return;
        try { await request(`/api/subscribers/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast('مشترک با موفقیت حذف شد.'); await loadSubscribers(); } catch (e) { toast(e.message, true); }
      }, true);
      action.append(actions); tr.append(name, tok, exp, status, action); body.append(tr);
    }
  }
  async function loadSubscribers() {
    if (!state.token) return;
    try { const data = await request('/api/subscribers'); state.subscribers = asSubscribers(data); filterSubscribers(); renderOverview(); }
    catch (e) { toast(e.message, true); }
  }
  function renderOverview() {
    const account = state.profile?.account || {};
    $('statTotal').textContent = account.totalSubscriptions ?? state.subscribers.length ?? '—';
    $('statActive').textContent = account.activeSubscriptions ?? state.subscribers.filter(s => s.isActive).length ?? '—';
    const agent = state.profile?.agent;
    $('statAgent').textContent = safe(typeof agent === 'string' ? agent : (agent?.name || agent?.type || 'مدیر')).slice(0, 26);
  }
  function appendDetail(host, title, value) { host.append(el('dt', '', title), el('dd', '', safe(value || '—'))); }
  function parseCredentials(account) {
    const description = text(account?.description);
    const match = /email:([\s\S]*?),password:([\s\S]*?),MFA:([\s\S]*)$/i.exec(description);
    return match ? { email: match[1].trim(), password: match[2].trim(), secret: match[3].trim() } : null;
  }
  function base32Bytes(secret) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const clean = secret.toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0, value = 0; const out = [];
    for (const chr of clean) { const digit = alphabet.indexOf(chr); if (digit < 0) throw new Error('کلید MFA معتبر نیست.'); value = (value << 5) | digit; bits += 5; if (bits >= 8) { out.push((value >>> (bits -= 8)) & 255); } }
    return new Uint8Array(out);
  }
  async function totp(secret) {
    const key = await crypto.subtle.importKey('raw', base32Bytes(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const buffer = new ArrayBuffer(8), view = new DataView(buffer);
    const step = Math.floor(Date.now() / 30000); view.setUint32(4, step);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
    const offset = digest[digest.length - 1] & 15;
    const num = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
    return String(num % 1_000_000).padStart(6, '0');
  }
  function renderAccount() {
    clearOtp(); const profile = state.profile || {}; const account = profile.account || {}; const agent = profile.agent || {};
    const host = $('accountInfo'); host.replaceChildren();
    appendDetail(host, 'نام', account.name || account.title);
    appendDetail(host, 'نماینده', typeof agent === 'string' ? agent : agent.name || agent.type);
    appendDetail(host, 'تعداد مشترک', account.totalSubscriptions);
    appendDetail(host, 'اشتراک فعال', account.activeSubscriptions);
    appendDetail(host, 'پیام سرور', profile.message);
    const credentials = parseCredentials(account), holder = $('credentialBlock'); holder.replaceChildren();
    if (!credentials) { holder.textContent = 'اطلاعات MFA در توضیحات این حساب ارائه نشده است.'; return; }
    holder.className = '';
    const email = el('div', 'credential-row'); email.append(el('span', '', credentials.email));
    const pwd = el('div', 'credential-row'); const hidden = el('span', '', '••••••••'); pwd.append(hidden);
    addButton(pwd, 'نمایش رمز', e => { const b = e.currentTarget; if (hidden.textContent === '••••••••') { hidden.textContent = credentials.password; b.textContent = 'پنهان'; } else { hidden.textContent = '••••••••'; b.textContent = 'نمایش رمز'; } });
    const code = el('div', 'mfa-code', '------'); const remaining = el('p', 'muted', '');
    holder.append(el('p', 'muted', 'ایمیل حساب'), email, el('p', 'muted', 'رمز عبور'), pwd, el('p', 'muted', 'رمز یکبارمصرف'), code, remaining);
    async function tick() {
      if (!state.token) return;
      try { code.textContent = await totp(credentials.secret); remaining.textContent = `اعتبار تا تغییر کد: ${30 - (Math.floor(Date.now() / 1000) % 30)} ثانیه`; }
      catch { code.textContent = 'نامعتبر'; remaining.textContent = 'کلید MFA ارائه‌شده قابل استفاده نیست.'; clearOtp(); }
    }
    tick(); state.otpTimer = setInterval(tick, 1000);
  }
  async function loadCookies() {
    try {
      const data = await request('/api/cookies/status'); const out = $('cookiesStatus'); out.replaceChildren();
      // Only show non-sensitive status keys. Never dump session cookies or credentials.
      const allowed = ['message', 'status', 'success', 'remaining', 'remainingDays', 'expiresAt', 'updatedAt', 'cookieType'];
      const items = allowed.filter(k => data && data[k] != null).map(k => `${k}: ${safe(data[k])}`);
      out.textContent = items.join('\n') || 'پاسخ سرور دریافت شد؛ جزئیات محرمانهٔ کوکی‌ها مخفی هستند.';
      toast('وضعیت کوکی‌ها دریافت شد.');
    } catch (e) { toast(e.message, true); }
  }
  async function loadProxies() {
    try {
      const data = await request('/api/proxies');
      const list = Array.isArray(data) ? data : Array.isArray(data?.proxies) ? data.proxies : [];
      const host = $('proxyList'); host.replaceChildren();
      if (!list.length) { host.append(el('div', 'empty-mini', 'پروکسی قابل نمایش یافت نشد.')); return; }
      for (const [i, proxy] of list.entries()) {
        const item = el('article', 'proxy-card');
        item.append(el('b', '', safe(proxy.name || proxy.NAME || `پروکسی ${i + 1}`)));
        item.append(el('p', '', safe(proxy.PROXY_HOST || proxy.host || proxy.PROXY_SERVER || 'نشانی نامشخص')));
        host.append(item);
      }
    } catch (e) { toast(e.message, true); }
  }
  async function refresh() {
    if (!state.token) return;
    try { const data = await request('/api/account'); state.profile = data.profile; renderOverview(); await loadSubscribers(); }
    catch (e) { toast(e.message, true); }
  }
  async function login(e) {
    e.preventDefault(); if (state.busy) return;
    const token = $('adminToken').value.trim();
    $('loginError').hidden = true;
    if (!token.startsWith('@') || token.length < 2) { $('loginError').textContent = 'تنها توکن مدیر که با @ آغاز می‌شود پذیرفته است.'; $('loginError').hidden = false; return; }
    state.busy = true; $('loginBtn').disabled = true;
    try {
      const data = await request('/api/login', { method: 'POST', body: { token }, token: '' });
      state.token = data.session; state.profile = data.profile;
      $('adminToken').value = ''; setScreen(true); renderOverview(); navigate('overview');
      await loadSubscribers(); toast('ورود مدیریتی تأیید شد.');
    } catch (error) { $('loginError').textContent = error.message; $('loginError').hidden = false; }
    finally { state.busy = false; $('loginBtn').disabled = false; }
  }
  document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
  $('loginForm').addEventListener('submit', login);
  $('toggleToken').addEventListener('click', () => { const input = $('adminToken'); input.type = input.type === 'password' ? 'text' : 'password'; $('toggleToken').textContent = input.type === 'password' ? 'نمایش' : 'پنهان'; });
  $('logoutBtn').addEventListener('click', async () => { try { await request('/api/logout',{method:'POST',body:{}}); } catch(e) { toast('خروج محلی انجام شد؛ ابطال سرور تأیید نشد: '+e.message,true); } finally { signOut(); } });
  $('refreshBtn').addEventListener('click', refresh);
  $('reloadSubscribers').addEventListener('click', loadSubscribers);
  $('subscriberSearch').addEventListener('input', filterSubscribers);
  $('newSubscriberBtn').addEventListener('click', () => $('subscriberDialog').showModal());
  $('subscriberForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { const data = await request('/api/subscribers', { method: 'POST', body: { name: $('newName').value.trim(), ...(isoDate($('newExpiry').value) ? { expiresAt: isoDate($('newExpiry').value) } : {}) } }); $('subscriberDialog').close(); $('subscriberForm').reset(); showResult(data); await loadSubscribers(); }
    catch (e) { toast(e.message, true); }
  });
  $('expiryForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await request(`/api/subscribers/${encodeURIComponent(state.expiryId)}`, { method: 'PATCH', body: { expiresAt: isoDate($('expiryValue').value) } }); $('expiryDialog').close(); toast('تاریخ انقضا تغییر کرد.'); await loadSubscribers(); }
    catch (e) { toast(e.message, true); }
  });
  $('copyResult').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('resultText').value); toast('نتیجه کپی شد.'); } catch { toast('کپی خودکار ممکن نیست.', true); } });
  $('reloadCookies').addEventListener('click', loadCookies);
  $('deleteCookies').addEventListener('click', async () => {
    if (!confirm('همهٔ کوکی‌های حساب از سرور حذف شوند؟ این عملیات قابل بازگشت نیست.')) return;
    try { const out = await request('/api/cookies', { method: 'DELETE' }); toast(safe(out.message || 'کوکی‌ها حذف شدند.')); await loadCookies(); } catch (e) { toast(e.message, true); }
  });
  $('cookieForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!confirm('کوکی‌های واردشده به سرویس GPT Yar ارسال شوند؟')) return;
    try { const cookies = JSON.parse($('cookieJson').value); const data = await request('/api/cookies', { method: 'POST', body: { cookie_type: $('cookieAgent').value, cookies } }); $('cookieJson').value = ''; toast(safe(data.message || 'کوکی‌ها بروزرسانی شدند.')); await loadCookies(); }
    catch (e) { toast('ورودی یا ارسال کوکی نامعتبر است: ' + e.message, true); }
  });
  $('reloadProxies').addEventListener('click', loadProxies);
  if (!configured()) {
    $('loginError').textContent = 'قبل از ورود، Backend Supabase را مستقر کنید و آدرس HTTPS آن را در config.js قرار دهید.';
    $('loginError').hidden = false;
  }
  window.GPTYAR_ADMIN_UI = {request,toast,base,session:()=>state.token};
  setScreen(false);
})();
