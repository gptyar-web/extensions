import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261018080907_gptyar_commerce.sql",
    import.meta.url,
  ),
  "utf8",
);
let db;
async function setup() {
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`,
  );
  await db.exec(migration);
}
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
async function order(
  c,
  {
    code = null,
    intent = "purchase",
    sub = null,
    mode = "live",
    quantity = 2,
    maxUsers = null,
    count = 0,
  } = {},
) {
  return (
    await q(
      `select to_jsonb(public.gy_new_order($1,$2,'day',$3,$4,$5,$6,$7,$8)) o`,
      [c, intent, quantity, mode, code, sub, maxUsers, count],
    )
  )[0].o;
}
const customer = async (user) =>
  (
    await q("insert into bot_customers(bale_user_id) values($1) returning id", [
      user,
    ])
  )[0].id;
const receipt = async (o, user, charge = "charge-" + o.id, verified = true) =>
  (
    await q(`select to_jsonb(gy_record_payment($1,$2,$3,'IRR',$4,$5,$6)) o`, [
      o.id,
      user,
      Number(o.total_rial),
      charge,
      "provider-" + charge,
      verified,
    ])
  )[0].o;
test("real PostgreSQL migration, RLS, order/payment transactions and idempotency", async (t) => {
  await setup();
  t.after(() => db.close());
  const c = await customer(101),
    other = await customer(102);
  await t.test(
    "all business tables enforce RLS; anon/authenticated cannot read tokens or call RPC",
    async () => {
      const tables = await q(
        "select relname,relrowsecurity from pg_class c join pg_namespace n on c.relnamespace=n.oid where n.nspname='public' and c.relkind='r'",
      );
      assert(tables.length >= 24);
      assert(tables.every((x) => x.relrowsecurity));
      for (const role of ["anon", "authenticated"]) {
        await db.exec("set role " + role);
        await assert.rejects(
          q("select * from subscriptions"),
          /permission denied/,
        );
        await assert.rejects(q("select gy_metrics()"), /permission denied/);
        await db.exec("reset role");
      }
    },
  );
  await t.test(
    "price snapshot is server calculated and remains stable after price change",
    async () => {
      const o = await order(c);
      assert.equal(o.total_rial, 700000);
      await q(
        "update pricing_rules set unit_price_rial=400000 where unit='day'",
      );
      assert.equal(
        (await q("select total_rial from orders where id=$1", [o.id]))[0]
          .total_rial,
        700000,
      );
    },
  );
  await t.test(
    "discount reservations prevent oversell and enforce per-customer limits",
    async () => {
      await q(
        "insert into discount_codes(code,kind,value,max_uses,per_customer) values('ONLYONE','percent',10,1,1)",
      );
      const first = await order(c, { code: "ONLYONE" });
      assert.equal(first.total_rial, 720000);
      await assert.rejects(
        order(other, { code: "ONLYONE" }),
        /DISCOUNT_EXHAUSTED/,
      );
      await q(
        "update discount_redemptions set reserved_until=now()-interval '1 minute' where order_id=$1",
        [first.id],
      );
      const next = await order(other, { code: "ONLYONE" });
      assert.equal(next.total_rial, 720000);
    },
  );
  await t.test(
    "discount remains reserved while an accepted checkout is pending",
    async () => {
      await q(
        "insert into discount_codes(code,kind,value,max_uses,per_customer) values('HOLDPAY','percent',5,1,1)",
      );
      const o = await order(c, { code: "HOLDPAY" });
      assert.equal(
        (
          await q("select gy_precheckout($1,101,$2,'IRR','held-charge') ok", [
            o.id,
            Number(o.total_rial),
          ])
        )[0].ok,
        true,
      );
      await q(
        "update discount_redemptions set reserved_until=now()-interval '1 minute' where order_id=$1",
        [o.id],
      );
      await assert.rejects(
        order(other, { code: "HOLDPAY" }),
        /DISCOUNT_EXHAUSTED/,
      );
    },
  );
  await t.test(
    "late SuccessfulPayment restarts an exhausted inquiry job without duplication",
    async () => {
      const o = await order(c);
      await q("select gy_precheckout($1,101,$2,'IRR','late-charge')", [
        o.id,
        Number(o.total_rial),
      ]);
      await q(
        "update outbox_jobs set state='failed',attempts=8 where dedupe_key=$1",
        ["verify:" + o.id],
      );
      await receipt(o, 101, "late-charge", false);
      const job = (
        await q("select state,attempts from outbox_jobs where dedupe_key=$1", [
          "verify:" + o.id,
        ])
      )[0];
      assert.equal(job.state, "pending");
      assert.equal(job.attempts, 0);
    },
  );
  await t.test(
    "unpaid/foreign renewals cannot escape ownership constraints",
    async () => {
      const s = (
        await q(
          "insert into subscriptions(customer_id,gptyar_subscription_id,account_id,token_ciphertext,token_fingerprint,name,expires_at) values($1,'remote-existing','account','cipher','fingerprint','owner',now()+interval '3 days') returning id",
          [c],
        )
      )[0].id;
      await assert.rejects(
        order(other, { intent: "renewal", sub: s }),
        /NOT_OWNER/,
      );
    },
  );
  await t.test(
    "capacity counts pending and paid reservations before taking money",
    async () => {
      const n = Number(
        (
          await q(
            "select count(*) n from orders where intent='purchase' and ((status='pending_payment' and invoice_expires_at>now()) or status in ('paid','awaiting_customer_details','provisioning','needs_review'))",
          )
        )[0].n,
      );
      await assert.rejects(
        order(c, { maxUsers: n + 1, count: 1 }),
        /ENTERPRISE_USER_LIMIT/,
      );
    },
  );
  await t.test(
    "payer/amount validation, duplicate receipt and transaction reuse",
    async () => {
      const o = await order(c);
      await assert.rejects(receipt(o, 102), /PAYMENT_MISMATCH/);
      const saved = await receipt(o, 101);
      assert.equal(saved.status, "awaiting_customer_details");
      await receipt(o, 101);
      assert.equal(
        (
          await q("select count(*) n from payments where order_id=$1", [o.id])
        )[0].n,
        1,
      );
      const second = await order(c);
      await assert.rejects(
        receipt(second, 101, "charge-" + o.id),
        /duplicate key/,
      );
      await assert.rejects(
        q("select gy_record_payment($1,101,1,'IRR','x','y',true)", [o.id]),
        /PAYMENT_MISMATCH/,
      );
    },
  );
  await t.test(
    "successful receipt remains durable even when inquiry is unavailable",
    async () => {
      const o = await order(c),
        saved = await receipt(o, 101, "inquiry-down", false);
      assert.equal(saved.status, "needs_review");
      assert.equal(
        (
          await q(
            "select count(*) n from outbox_jobs where kind='verify_payment' and aggregate_id=$1",
            [o.id],
          )
        )[0].n,
        1,
      );
      const confirmed = await receipt(o, 101, "inquiry-down", true);
      assert.equal(confirmed.status, "awaiting_customer_details");
      assert.equal(
        (await q("select status from payments where order_id=$1", [o.id]))[0]
          .status,
        "paid",
      );
    },
  );
  await t.test(
    "customer details after payment enqueue exactly one provision job",
    async () => {
      const o = await order(c);
      await receipt(o, 101);
      await q("select gy_customer_details($1,$2,'نام','خانوادگی')", [o.id, c]);
      await assert.rejects(
        q("select gy_customer_details($1,$2,'نام','خانوادگی')", [o.id, other]),
        /ORDER_NOT_READY/,
      );
      assert.equal(
        (
          await q("select count(*) n from outbox_jobs where dedupe_key=$1", [
            "provision:" + o.id,
          ])
        )[0].n,
        1,
      );
      const args = [
        o.id,
        "remote-" + o.id,
        "account",
        "encrypted",
        "hash-" + o.id,
        "customer",
        new Date(Date.now() + 86400000).toISOString(),
      ];
      const sql = "select gy_complete_order($1,$2,$3,$4,$5,$6,$7) s",
        first = (await q(sql, args))[0].s,
        second = (await q(sql, args))[0].s;
      assert.equal(first, second);
      assert.equal(
        (
          await q(
            "select count(*) n from subscriptions where gptyar_subscription_id=$1",
            ["remote-" + o.id],
          )
        )[0].n,
        1,
      );
    },
  );
  await t.test(
    "test-mode payment can never create a real subscription",
    async () => {
      const o = await order(c, { mode: "test" });
      await receipt(o, 101);
      await q("select gy_customer_details($1,$2,'نام','خانوادگی')", [o.id, c]);
      await assert.rejects(
        q(
          "select gy_complete_order($1,'fake','account','cipher','fake-hash','customer',now()+interval '1 day')",
          [o.id],
        ),
        /PAYMENT_NOT_VERIFIED/,
      );
    },
  );
  await t.test(
    "webhook duplicate ID commits one update and one job; job leases are exclusive",
    async () => {
      await q("select gy_ingest_update(999,'cipher')");
      await q("select gy_ingest_update(999,'cipher')");
      assert.equal(
        (
          await q(
            "select count(*) n from outbox_jobs where dedupe_key='update:999'",
          )
        )[0].n,
        1,
      );
      const one = (await q("select id from gy_claim_job()"))[0],
        two = (await q("select id from gy_claim_job()"))[0];
      assert.notEqual(one.id, two.id);
      assert.equal(
        (
          await q(
            "select gy_lease('worker','11111111-1111-4111-8111-111111111111',60) ok",
          )
        )[0].ok,
        true,
      );
      assert.equal(
        (
          await q(
            "select gy_lease('worker','22222222-2222-4222-8222-222222222222',60) ok",
          )
        )[0].ok,
        false,
      );
    },
  );
});
