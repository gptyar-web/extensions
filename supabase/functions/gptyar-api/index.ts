import { createHandler } from "../_shared/handler.js";
const env = Deno.env.toObject();
Deno.serve(
  createHandler(env, (promise: Promise<unknown>) => {
    // @ts-ignore EdgeRuntime is provided by Supabase, not by local Deno.
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(promise);
  }),
);
