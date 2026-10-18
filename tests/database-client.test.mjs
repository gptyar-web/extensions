import test from "node:test";
import assert from "node:assert/strict";
import { databasePath } from "../supabase/functions/_shared/clients.js";

test("database access always targets GPT Yar tables and RPCs in a shared project", () => {
  assert.equal(databasePath("audit_logs"), "gptyar_audit_logs");
  assert.equal(databasePath("rpc/gy_metrics"), "rpc/gptyar_metrics");
  const path = databasePath(
    "orders?select=*,bot_customers(bale_user_id,first_name),payments(status),subscriptions(expires_at)&status=eq.needs_review&limit=100",
  );
  const url = new URL(path, "https://database.example/");
  assert.equal(url.pathname, "/gptyar_orders");
  assert.equal(
    url.searchParams.get("select"),
    "*,bot_customers:gptyar_bot_customers(bale_user_id,first_name),payments:gptyar_payments(status),subscriptions:gptyar_subscriptions(expires_at)",
  );
  assert.equal(url.searchParams.get("status"), "eq.needs_review");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.throws(
    () => databasePath("profiles"),
    /DATABASE_RESOURCE_NOT_ALLOWED/,
  );
  assert.throws(
    () => databasePath("rpc/foreign_function"),
    /DATABASE_RESOURCE_NOT_ALLOWED/,
  );
});
