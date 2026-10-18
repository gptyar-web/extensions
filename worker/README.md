# Archived Cloudflare implementation

This directory preserves the previous gateway and its regression tests as migration reference. It is **not** the backend of the current panel. Deployment scripts are disabled; production uses only `supabase/functions/gptyar-api`. All previous management routes are available there using opaque server sessions. Do not configure the new panel to point to the legacy gateway, which returns no session.
