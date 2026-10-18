begin;
-- Dedicated GPT Yar project. Additive schema; no existing data is dropped.
create table public.admin_sessions (
 id uuid primary key default gen_random_uuid(), session_hash text not null unique,
 account_id text not null, admin_fingerprint text not null, token_ciphertext text not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null,
 revalidated_at timestamptz not null default now(), revoked_at timestamptz
);
create table public.secure_settings (
 key text primary key, ciphertext text not null, updated_by uuid references public.admin_sessions(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.system_settings (
 key text primary key, value jsonb not null, updated_at timestamptz not null default now()
);
insert into public.system_settings(key,value) values
 ('bot','{"enabled":false,"connected":false}'),
 ('wallet','{"enabled":false,"mode":"test","verified":false}'),
 ('limits','{"confirmed":false}'),
 ('support','{"url":"https://eitaa.com/gptyar","site":"https://gptyar-web.github.io/"}');
create table public.bot_customers (
 id uuid primary key default gen_random_uuid(), bale_user_id bigint not null unique check(bale_user_id>0),
 first_name text,last_name text, created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.bot_conversations (
 customer_id uuid primary key references public.bot_customers(id), step text not null default 'menu',
 context jsonb not null default '{}', last_update_id bigint, updated_at timestamptz not null default now()
);
create table public.products (
 id text primary key, title text not null, automatic boolean not null default false, active boolean not null default true
);
insert into public.products(id,title,automatic) values('chatgpt-plus-shared','ChatGPT Plus اشتراکی',true);
create table public.pricing_rules (
 id uuid primary key default gen_random_uuid(),product_id text not null references public.products(id),
 unit text not null check(unit in ('day','month')),unit_price_rial bigint not null check(unit_price_rial>0 and unit_price_rial<=100000000000),
 enabled boolean not null default true,min_quantity integer not null default 1 check(min_quantity>0),
 max_quantity integer not null check(max_quantity>=min_quantity and max_quantity<=10000),
 updated_at timestamptz not null default now(),unique(product_id,unit)
);
insert into public.pricing_rules(product_id,unit,unit_price_rial,max_quantity) values
 ('chatgpt-plus-shared','day',350000,60),('chatgpt-plus-shared','month',10000000,2);
create table public.discount_codes (
 id uuid primary key default gen_random_uuid(),code text not null unique check(code=upper(code) and code ~ '^[A-Z0-9_-]{3,40}$'),
 kind text not null check(kind in ('percent','fixed')),value bigint not null check(value>0),
 scope text not null default 'both' check(scope in ('purchase','renewal','both')),
 starts_at timestamptz not null default now(),ends_at timestamptz,
 max_uses integer check(max_uses>0),per_customer integer not null default 1 check(per_customer>0),
 active boolean not null default true,archived boolean not null default false,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(kind<>'percent' or value<=100),check(ends_at is null or ends_at>starts_at)
);
create table public.subscriptions (
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.bot_customers(id),
 gptyar_subscription_id text not null unique,account_id text not null,token_ciphertext text not null,
 token_fingerprint text not null unique,name text not null,expires_at timestamptz not null,
 is_active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.orders (
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.bot_customers(id),
 product_id text not null references public.products(id),purpose text not null default 'sale' check(purpose in ('sale','wallet_probe')),intent text not null check(intent in ('purchase','renewal')),
 subscription_id uuid references public.subscriptions(id),unit text not null check(unit in ('day','month')),
 quantity integer not null check(quantity>0),unit_price_rial bigint not null check(unit_price_rial>0),
 subtotal_rial bigint not null check(subtotal_rial>0),discount_rial bigint not null default 0 check(discount_rial>=0),
 total_rial bigint not null check(total_rial>0),discount_id uuid references public.discount_codes(id),
 status text not null default 'pending_payment' check(status in ('pending_payment','paid','awaiting_customer_details','provisioning','completed','failed','needs_review','cancelled')),
 mode text not null check(mode in ('test','live')),wallet_revision text,invoice_expires_at timestamptz not null,
 invoice_message_id text,first_name text,last_name text,error_code text,
 paid_at timestamptz,completed_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(total_rial=subtotal_rial-discount_rial),constraint orders_renewal_subscription check(intent<>'renewal' or subscription_id is not null)
);
create table public.payments (
 id uuid primary key default gen_random_uuid(),order_id uuid not null unique references public.orders(id),
 bale_charge_id text unique,provider_charge_id text unique,payer_bale_id bigint not null,
 currency text not null default 'IRR' check(currency='IRR'),amount_rial bigint not null check(amount_rial>0),
 status text not null check(status in ('pending','paid','failed','rejected','needs_review','refund_required','refunded')),
 mode text not null check(mode in ('test','live')),verified_at timestamptz,refund_reference text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.subscription_operations (
 id uuid primary key default gen_random_uuid(),order_id uuid not null unique references public.orders(id),
 kind text not null check(kind in ('purchase','renewal')),phase text not null default 'prepared'
 check(phase in ('prepared','requesting','uncertain','completed','failed')),
 request_name text not null,target_expires_at timestamptz not null,previous_expires_at timestamptz,
 gptyar_subscription_id text,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.discount_redemptions (
 id uuid primary key default gen_random_uuid(),discount_id uuid not null references public.discount_codes(id),
 customer_id uuid not null references public.bot_customers(id),order_id uuid not null unique references public.orders(id),
 state text not null default 'reserved' check(state in ('reserved','used','released')),
 reserved_until timestamptz not null,created_at timestamptz not null default now()
);
create table public.educational_videos (
 id uuid primary key default gen_random_uuid(),slug text not null unique,title text not null,
 description text not null default '',storage_path text,poster_path text,sort_order integer not null default 0,
 active boolean not null default false,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
insert into public.educational_videos(slug,title,sort_order) values
 ('android','فعال‌سازی اندروید',1),('windows','فعال‌سازی ویندوز',2),('iphone','فعال‌سازی آیفون',3),('dedicated','فعال‌سازی حساب اختصاصی',4);
create table public.extension_versions (
 id uuid primary key default gen_random_uuid(),version text not null unique check(version ~ '^\d+(\.\d+){0,3}$'),
 changelog text not null default '',storage_path text not null,download_link text,
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),size_bytes bigint not null check(size_bytes>0),
 manifest jsonb not null,update_endpoint text,update_mode text not null default 'OPTIONAL' check(update_mode in ('OPTIONAL','FORCED')),
 published boolean not null default false,rollback boolean not null default false,
 created_at timestamptz not null default now(),published_at timestamptz
);
create unique index extension_single_published on public.extension_versions(published) where published;
create table public.audit_logs (
 id bigint generated always as identity primary key,session_id uuid references public.admin_sessions(id),
 action text not null,target_id text,metadata jsonb not null default '{}',created_at timestamptz not null default now()
);
create table public.system_events (
 id bigint generated always as identity primary key,level text not null,event_code text not null,
 order_id uuid references public.orders(id),details jsonb not null default '{}',created_at timestamptz not null default now()
);
create table public.bot_updates (
 update_id bigint primary key,customer_id uuid references public.bot_customers(id),payload_ciphertext text not null,
 state text not null default 'pending' check(state in ('pending','processing','done','failed')),
 created_at timestamptz not null default now()
);
create table public.outbox_jobs (
 id uuid primary key default gen_random_uuid(),dedupe_key text not null unique,
 kind text not null check(kind in ('bot_update','provision','deliver','verify_payment','admin_notice')),
 aggregate_id text not null,payload jsonb not null default '{}',state text not null default 'pending'
 check(state in ('pending','running','done','failed')),attempts integer not null default 0,
 available_at timestamptz not null default now(),locked_until timestamptz,lease_token uuid,
 last_error text,created_at timestamptz not null default now()
);
create table public.rate_limits (key text primary key,window_start timestamptz not null, hits integer not null);
create table public.resource_leases (key text primary key,owner uuid not null,until_at timestamptz not null);
create table public.ownership_claims (
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.bot_customers(id),
 token_ciphertext text not null,token_fingerprint text not null,status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(),unique(customer_id,token_fingerprint)
);
create table public.upload_tickets (
 id uuid primary key default gen_random_uuid(),bucket text not null,path text not null unique,mime text not null,
 session_id uuid not null references public.admin_sessions(id),expires_at timestamptz not null,used_at timestamptz
);
create table public.payment_receipts (
 id uuid primary key default gen_random_uuid(),charge_id text not null unique,payer_bale_id bigint not null,
 payload_ciphertext text not null,status text not null default 'received' check(status in ('received','matched','needs_review')),
 order_id uuid references public.orders(id),error_code text,created_at timestamptz not null default now()
);
create index receipts_order on public.payment_receipts(order_id);
create table public.admin_requests (
 session_id uuid not null references public.admin_sessions(id),request_id uuid not null,created_at timestamptz not null default now(),primary key(session_id,request_id)
);
create index subscriptions_customer on public.subscriptions(customer_id);
create index subscriptions_expiry on public.subscriptions(expires_at);
create index orders_customer_created on public.orders(customer_id,created_at desc);
create index orders_status_created on public.orders(status,created_at desc);
create index orders_subscription on public.orders(subscription_id);
create index orders_discount on public.orders(discount_id);
create index pricing_product on public.pricing_rules(product_id);
create index redemptions_discount_customer on public.discount_redemptions(discount_id,customer_id);
create index redemptions_customer on public.discount_redemptions(customer_id);
create index operations_status on public.subscription_operations(phase,updated_at);
create index events_order on public.system_events(order_id);
create index jobs_due on public.outbox_jobs(state,available_at);
create index claims_customer on public.ownership_claims(customer_id);
create index uploads_session on public.upload_tickets(session_id);
create index sessions_expiry on public.admin_sessions(expires_at) where revoked_at is null;
create index audit_session on public.audit_logs(session_id);
create index secure_settings_session on public.secure_settings(updated_by);
create index updates_customer on public.bot_updates(customer_id);
create function public.gy_touch() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
do $$ declare t text; begin
 foreach t in array array['secure_settings','system_settings','bot_customers','bot_conversations','pricing_rules','orders','payments','subscriptions','subscription_operations','discount_codes','educational_videos'] loop
 execute format('create trigger touch_updated before update on public.%I for each row execute function public.gy_touch()',t);
 end loop;
end $$;

create function public.gy_rate(p_key text,p_limit integer,p_seconds integer) returns boolean
language plpgsql set search_path='' as $$
declare n integer; begin
 insert into public.rate_limits(key,window_start,hits) values(p_key,now(),1)
 on conflict(key) do update set hits=case when public.rate_limits.window_start<now()-make_interval(secs=>p_seconds) then 1 else public.rate_limits.hits+1 end,
 window_start=case when public.rate_limits.window_start<now()-make_interval(secs=>p_seconds) then now() else public.rate_limits.window_start end returning hits into n;
 return n<=p_limit; end $$;

create function public.gy_lease(p_key text,p_owner uuid,p_seconds integer) returns boolean
language plpgsql set search_path='' as $$
declare n integer; begin
 insert into public.resource_leases(key,owner,until_at) values(p_key,p_owner,now()+make_interval(secs=>p_seconds))
 on conflict(key) do update set owner=excluded.owner,until_at=excluded.until_at
 where public.resource_leases.until_at<now() or public.resource_leases.owner=p_owner;
 get diagnostics n=row_count;return n=1;end $$;

create function public.gy_new_order(p_customer uuid,p_intent text,p_unit text,p_quantity integer,p_mode text,p_code text default null,p_subscription uuid default null,p_max_users integer default null,p_server_count integer default 0)
returns public.orders language plpgsql set search_path='' as $$
declare r public.pricing_rules;d public.discount_codes;o public.orders; sub bigint;off bigint:=0;used integer; reserved integer;
begin
 perform pg_advisory_xact_lock(4652026); -- capacity reservations serialize locally
 if p_intent not in ('purchase','renewal') or p_mode not in ('test','live') then raise exception 'INVALID_ORDER';end if;
 if p_intent='renewal' and not exists(select 1 from public.subscriptions where id=p_subscription and customer_id=p_customer) then raise exception 'NOT_OWNER';end if;
 select * into r from public.pricing_rules where product_id='chatgpt-plus-shared' and unit=p_unit for share;
 if not found or not r.enabled or p_quantity<r.min_quantity or p_quantity>r.max_quantity then raise exception 'DURATION_NOT_AVAILABLE';end if;
 if p_intent='purchase' and p_max_users is not null then
 select count(*) into reserved from public.orders where intent='purchase' and purpose='sale' and mode=p_mode and ((status='pending_payment' and invoice_expires_at>now()) or status in ('paid','awaiting_customer_details','provisioning','needs_review'));
 if p_server_count+reserved>=p_max_users then raise exception 'ENTERPRISE_USER_LIMIT';end if;end if;
 sub:=r.unit_price_rial*p_quantity;
 if p_code is not null then
 select * into d from public.discount_codes where code=upper(trim(p_code)) for update;
 if not found or not d.active or d.archived or d.starts_at>now() or (d.ends_at is not null and d.ends_at<=now()) or d.scope not in ('both',p_intent) then raise exception 'DISCOUNT_INVALID';end if;
 select count(*) into used from public.discount_redemptions where discount_id=d.id and (state='used' or (state='reserved' and (reserved_until>now() or exists(select 1 from public.payments p where p.order_id=public.discount_redemptions.order_id and p.status in ('pending','paid','needs_review')))));
 if d.max_uses is not null and used>=d.max_uses then raise exception 'DISCOUNT_EXHAUSTED';end if;
 select count(*) into used from public.discount_redemptions where discount_id=d.id and customer_id=p_customer and (state='used' or (state='reserved' and (reserved_until>now() or exists(select 1 from public.payments p where p.order_id=public.discount_redemptions.order_id and p.status in ('pending','paid','needs_review')))));
 if used>=d.per_customer then raise exception 'DISCOUNT_CUSTOMER_LIMIT';end if;
 off:=least(sub-1,case when d.kind='percent' then floor(sub::numeric*d.value/100)::bigint else d.value end);end if;
 insert into public.orders(customer_id,product_id,intent,subscription_id,unit,quantity,unit_price_rial,subtotal_rial,discount_rial,total_rial,discount_id,mode,wallet_revision,invoice_expires_at)
 values(p_customer,r.product_id,p_intent,p_subscription,p_unit,p_quantity,r.unit_price_rial,sub,off,sub-off,d.id,p_mode,(select value->>'revision' from public.system_settings where key='wallet'),now()+interval '20 minutes') returning * into o;
 if d.id is not null then insert into public.discount_redemptions(discount_id,customer_id,order_id,reserved_until) values(d.id,p_customer,o.id,o.invoice_expires_at);end if;
 return o;end $$;

create function public.gy_ingest_update(p_id bigint,p_ciphertext text) returns boolean
language plpgsql set search_path='' as $$
declare n integer;begin
 insert into public.bot_updates(update_id,payload_ciphertext) values(p_id,p_ciphertext) on conflict do nothing;
 get diagnostics n=row_count;
 if n=1 then insert into public.outbox_jobs(dedupe_key,kind,aggregate_id) values('update:'||p_id,'bot_update',p_id::text);end if;return n=1;end $$;

create function public.gy_cancel_unpaid(p_customer uuid) returns void language plpgsql set search_path='' as $$
begin
 update public.orders o set status='cancelled' where customer_id=p_customer and status='pending_payment' and not exists(select 1 from public.payments p where p.order_id=o.id and p.status in ('pending','paid','needs_review'));
 update public.discount_redemptions r set state='released' where customer_id=p_customer and state='reserved' and exists(select 1 from public.orders o where o.id=r.order_id and o.status='cancelled');
end $$;

create function public.gy_precheckout(p_order uuid,p_user bigint,p_amount bigint,p_currency text,p_charge text) returns boolean
language plpgsql set search_path='' as $$
declare o public.orders;c public.bot_customers; p public.payments;begin
 select * into o from public.orders where id=p_order for update;
 if not found or o.status<>'pending_payment' or o.invoice_expires_at<=now() then return false;end if;
 select * into c from public.bot_customers where id=o.customer_id;
 if c.bale_user_id<>p_user or o.total_rial<>p_amount or p_currency<>'IRR' then return false;end if;
 select * into p from public.payments where order_id=o.id;
 if found then return p.bale_charge_id=p_charge and p.status='pending';end if;
 insert into public.payments(order_id,bale_charge_id,payer_bale_id,amount_rial,status,mode) values(o.id,p_charge,p_user,p_amount,'pending',o.mode);
 insert into public.outbox_jobs(dedupe_key,kind,aggregate_id,available_at) values('verify:'||o.id,'verify_payment',o.id::text,now()+interval '20 seconds') on conflict do nothing;
 return true;
end $$;

create function public.gy_record_payment(p_order uuid,p_user bigint,p_amount bigint,p_currency text,p_charge text,p_provider text,p_verified boolean)
returns public.orders language plpgsql set search_path='' as $$
declare o public.orders;c public.bot_customers;existing public.payments;begin
 select * into o from public.orders where id=p_order for update;
 if not found then raise exception 'ORDER_NOT_FOUND';end if;
 select * into c from public.bot_customers where id=o.customer_id;
 if c.bale_user_id<>p_user or o.total_rial<>p_amount or p_currency<>'IRR' then raise exception 'PAYMENT_MISMATCH';end if;
 select * into existing from public.payments where order_id=o.id;
 if found and (existing.bale_charge_id<>p_charge or existing.provider_charge_id<>p_provider) then raise exception 'DUPLICATE_CHARGE';end if;
 insert into public.payments(order_id,bale_charge_id,provider_charge_id,payer_bale_id,amount_rial,status,mode,verified_at)
 values(o.id,p_charge,nullif(p_provider,''),p_user,p_amount,case when p_verified then 'paid' else 'needs_review' end,o.mode,case when p_verified then now() end)
 on conflict(order_id) do update set status=case when public.payments.status='paid' then 'paid' else excluded.status end,verified_at=coalesce(public.payments.verified_at,excluded.verified_at),provider_charge_id=coalesce(public.payments.provider_charge_id,excluded.provider_charge_id);
 if o.status in ('completed','provisioning','awaiting_customer_details','paid') then return o;end if;
 update public.orders set status=case when p_verified then case when intent='renewal' then 'paid' else 'awaiting_customer_details' end else 'needs_review' end,paid_at=coalesce(paid_at,now()) where id=o.id returning * into o;
 update public.discount_redemptions set state='used' where order_id=o.id;
 if p_verified then
 insert into public.outbox_jobs(dedupe_key,kind,aggregate_id) values(case when o.intent='renewal' then 'provision:' else 'deliver:' end||o.id,case when o.intent='renewal' then 'provision' else 'deliver' end,o.id::text) on conflict do nothing;
 else insert into public.outbox_jobs(dedupe_key,kind,aggregate_id,available_at) values('verify:'||o.id,'verify_payment',o.id::text,now()+interval '15 seconds') on conflict(dedupe_key) do update set state='pending',attempts=0,available_at=now()+interval '15 seconds',last_error=null where public.outbox_jobs.state='failed';end if;
 return o;end $$;

create function public.gy_customer_details(p_order uuid,p_customer uuid,p_first text,p_last text) returns public.orders
language plpgsql set search_path='' as $$
declare o public.orders;begin
 select * into o from public.orders where id=p_order and customer_id=p_customer for update;
 if not found or o.status<>'awaiting_customer_details' or not exists(select 1 from public.payments where order_id=o.id and status='paid') then raise exception 'ORDER_NOT_READY';end if;
 update public.orders set first_name=p_first,last_name=p_last,status='paid' where id=o.id returning * into o;
 update public.bot_customers set first_name=p_first,last_name=p_last where id=p_customer;
 insert into public.outbox_jobs(dedupe_key,kind,aggregate_id) values('provision:'||o.id,'provision',o.id::text) on conflict do nothing;return o;end $$;

create function public.gy_claim_job() returns setof public.outbox_jobs language sql set search_path='' as $$
 update public.outbox_jobs set state='running',lease_token=gen_random_uuid(),locked_until=now()+interval '3 minutes',attempts=attempts+1
 where id=(select id from public.outbox_jobs where (state='pending' and available_at<=now()) or (state='running' and locked_until<now()) order by available_at for update skip locked limit 1) returning *;
$$;

create function public.gy_complete_order(p_order uuid,p_remote_id text,p_account text,p_ciphertext text,p_fingerprint text,p_name text,p_expiry timestamptz)
returns uuid language plpgsql set search_path='' as $$
declare o public.orders;s uuid;begin
 select * into o from public.orders where id=p_order for update;
 if o.status='completed' then return o.subscription_id;end if;
 if o.status not in ('paid','provisioning','needs_review') or not exists(select 1 from public.payments where order_id=o.id and status='paid' and mode='live') then raise exception 'PAYMENT_NOT_VERIFIED';end if;
 if o.intent='purchase' then
 insert into public.subscriptions(customer_id,gptyar_subscription_id,account_id,token_ciphertext,token_fingerprint,name,expires_at)
 values(o.customer_id,p_remote_id,p_account,p_ciphertext,p_fingerprint,p_name,p_expiry) returning id into s;
 else
 update public.subscriptions set expires_at=p_expiry,is_active=true where id=o.subscription_id and customer_id=o.customer_id and gptyar_subscription_id=p_remote_id returning id into s;
 if s is null then raise exception 'NOT_OWNER';end if;end if;
 -- For purchases subscription_id is assigned only after completion; enforce intent check separately below.
 update public.orders set subscription_id=s,status='completed',completed_at=now(),error_code=null where id=o.id;
 update public.subscription_operations set phase='completed',gptyar_subscription_id=p_remote_id where order_id=o.id;
 insert into public.outbox_jobs(dedupe_key,kind,aggregate_id) values('complete-deliver:'||o.id,'deliver',o.id::text) on conflict do nothing;
 return s;end $$;

create function public.gy_publish(p_id uuid,p_rollback boolean) returns void language plpgsql set search_path='' as $$
begin perform pg_advisory_xact_lock(4652027);
 if not exists(select 1 from public.extension_versions where id=p_id) then raise exception 'VERSION_NOT_FOUND';end if;
 update public.extension_versions set published=false where published;
 update public.extension_versions set published=true,rollback=p_rollback,published_at=now() where id=p_id;end $$;

create function public.gy_metrics() returns jsonb language sql set search_path='' as $$
 select jsonb_build_object(
 'customers',(select count(*) from public.bot_customers),
 'active',(select count(*) from public.subscriptions where is_active and expires_at>now()),
 'expired',(select count(*) from public.subscriptions where expires_at<=now()),
 'orders_today',(select count(*) from public.orders where created_at>=date_trunc('day',now() at time zone 'Asia/Tehran') at time zone 'Asia/Tehran'),
 'successful',(select count(*) from public.payments where status='paid' and mode='live' and order_id in (select id from public.orders where purpose='sale')),
 'failed',(select count(*) from public.payments where status in ('failed','rejected')),
 'sales',(select coalesce(sum(amount_rial),0) from public.payments where status='paid' and mode='live' and order_id in (select id from public.orders where purpose='sale')),
 'daily',(select coalesce(sum(amount_rial),0) from public.payments where status='paid' and mode='live' and order_id in (select id from public.orders where purpose='sale') and verified_at>=date_trunc('day',now() at time zone 'Asia/Tehran') at time zone 'Asia/Tehran'),
 'monthly',(select coalesce(sum(amount_rial),0) from public.payments where status='paid' and mode='live' and order_id in (select id from public.orders where purpose='sale') and verified_at>=date_trunc('month',now() at time zone 'Asia/Tehran') at time zone 'Asia/Tehran'),
 'renewals',(select count(*) from public.orders where intent='renewal' and status='completed' and mode='live' and purpose='sale'),
 'tokens',(select count(*) from public.orders where intent='purchase' and status='completed' and mode='live' and purpose='sale'),
 'pending',(select count(*) from public.orders where status in ('pending_payment','paid','awaiting_customer_details','provisioning')),
 'needs_review',(select count(*) from public.orders where status='needs_review'));
$$;

create function public.gy_record_refund(p_order uuid,p_reference text) returns void language plpgsql set search_path='' as $$
declare o public.orders;begin
 select * into o from public.orders where id=p_order for update;
 if not found or o.status<>'needs_review' or length(trim(p_reference))<4 then raise exception 'ORDER_NOT_REVIEWABLE';end if;
 update public.payments set status='refunded',refund_reference=p_reference where order_id=p_order and status in ('paid','refund_required');
 if not found then raise exception 'PAYMENT_NOT_REFUNDABLE';end if;
 update public.orders set status='cancelled',error_code='MANUAL_REFUND_RECORDED' where id=p_order;
end $$;

create function public.gy_attach_claim(p_claim uuid,p_remote text,p_account text,p_ciphertext text,p_name text,p_expiry timestamptz) returns void language plpgsql set search_path='' as $$
declare c public.ownership_claims;begin
 select * into c from public.ownership_claims where id=p_claim and status='pending' for update;
 if not found then raise exception 'CLAIM_NOT_FOUND';end if;
 insert into public.subscriptions(customer_id,gptyar_subscription_id,account_id,token_ciphertext,token_fingerprint,name,expires_at)
 values(c.customer_id,p_remote,p_account,p_ciphertext,c.token_fingerprint,p_name,p_expiry);
 update public.ownership_claims set status='approved' where id=c.id;
end $$;

create function public.gy_pair_admin(p_hash text,p_user bigint) returns boolean language plpgsql set search_path='' as $$
declare v jsonb;begin
 select value into v from public.system_settings where key='admin_notification_pair' for update;
 if not found or v->>'hash'<>p_hash or (v->>'expires_at')::timestamptz<now() or coalesce((v->>'used')::boolean,false) then return false;end if;
 insert into public.system_settings(key,value) values('notifications',jsonb_build_object('enabled',true,'bale_user_id',p_user::text,'paired_at',now())) on conflict(key) do update set value=excluded.value;
 update public.system_settings set value=value||'{"used":true}'::jsonb where key='admin_notification_pair';
 insert into public.audit_logs(session_id,action,target_id) values((v->>'session_id')::uuid,'notification_private_chat_paired',p_user::text);
 return true;
end $$;

create function public.gy_housekeeping() returns void language plpgsql set search_path='' as $$
begin
 delete from public.rate_limits where window_start<now()-interval '1 day';
 delete from public.admin_requests where created_at<now()-interval '1 day';
 update public.admin_sessions set token_ciphertext='' where expires_at<now()-interval '1 day' and token_ciphertext<>'';
 delete from public.bot_updates where state='done' and created_at<now()-interval '30 days';
 update public.discount_redemptions set state='released' where state='reserved' and reserved_until<now() and not exists(select 1 from public.payments p where p.order_id=public.discount_redemptions.order_id and p.status in ('pending','paid','needs_review'));
end $$;

-- No direct browser access, including authenticated Supabase users. Only Edge Functions use service_role.
do $$ declare t text;f record;begin
 foreach t in array array['payment_receipts','admin_requests','admin_sessions','secure_settings','system_settings','bot_customers','bot_conversations','products','pricing_rules','orders','payments','subscriptions','subscription_operations','discount_codes','discount_redemptions','educational_videos','extension_versions','audit_logs','system_events','bot_updates','outbox_jobs','rate_limits','resource_leases','ownership_claims','upload_tickets'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy backend_only on public.%I to service_role using (true) with check (true)',t);
 end loop;
 for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname like 'gy\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);
 execute format('grant execute on function %s to service_role',f.sig);
 end loop;
end $$;
grant usage,select on sequence public.audit_logs_id_seq,public.system_events_id_seq to service_role;
-- Storage buckets stay private. Public media is served through controlled, short-lived signed URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('gptyar-videos','gptyar-videos',false,524288000,array['video/mp4','video/webm']),
 ('gptyar-posters','gptyar-posters',false,5242880,array['image/jpeg','image/png','image/webp']),
 ('gptyar-releases','gptyar-releases',false,20971520,array['application/zip'])
on conflict(id) do nothing;
commit;
