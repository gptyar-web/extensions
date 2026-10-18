# Source audit — 4.6.5

Reference: the user-supplied `v4.6.5(1).rar`, 33 files, Manifest V3, manifest/package version 4.6.5. The repository `chatgpt` previously contained only README and `v4.6.2.zip`, so that older ZIP was not used as the current contract.

RAR SHA-256: `ad49267188b207020e6601a49c1570cb436b7481b2c4fa89dd909b0fc45841bf`

Source hashes:

| File | SHA-256 |
|---|---|
| manifest.json | `1a50de8063a337a74e2a01ab9aff325cc268ef509139832b7447c32faebf40c5` |
| accupdator-manager.js | `574cc5999aca8d039a28bb126e46a018542606ff9dc4d1e17f560a941c5d6878` |
| background.js | `59402a7adc5b648b93f179555157306661f6fd2cc857afb3d4dd76969a8de9b7` |

Obfuscation was resolved by evaluating only the string-table/bootstrap routines in an isolated VM with a timeout, then replacing literal decoder calls in an AST. No extension browser logic was executed for this analysis. The imported source in `chatgpt/extension` retains the original obfuscation; functional changes are limited to the update request call and manifest/package version; inherited trailing whitespace in CSS/HTML is normalized.

Base URL: `https://api.gptyar.com`. All management requests carry `Authorization: Bearer <admin token>`. JSON bodies are as follows:

| Method/path | Request | Observed response fields used by 4.6.5 |
|---|---|---|
| POST /accupdator/validate | `{token, version}` | `message`, `account`, `agent`; account includes `id`, `type`, `limits`, subscription counts |
| GET /accupdator/subscribers/all | no body | `accountId`, `accountType`, `limits`, `subscribers[]` |
| POST /accupdator/subscribers/create | `{name, expiresAt?}` | top-level `subscriptionId`, `name`, `token`, `expiresAt` |
| PATCH /accupdator/subscribers/update | `{subscriptionId, expiresAt}` | success body not assumed to contain expiry; new implementation reads the actual list after mutation |
| DELETE /accupdator/subscribers/delete | `{subscriptionId}` | success body |
| POST /accupdator/fetch-cookies | `{token}` | cookie status |
| POST /accupdator/update-cookies | `{token, cookie_type, cookies}` | success body |
| DELETE /accupdator/delete-cookies | `{token}` | success body |
| POST /client/proxy-info | `{token}` | proxy information |

Subscriber list fields used by the source: `subscriptionId`, `name`, `token`, `expiresAt`, `isActive`. The backend fails closed when required fields differ. A source reference is not equivalent to a successful live request.

The current panel's previous backend validated only positive response shape. The new backend additionally calls the management-only list endpoint, requires HTTP success, a valid subscriber array and matching account scope, and pins the deployment to `GPTYAR_ACCOUNT_ID`. There is no invented `isAdmin` response field.

For ENTERPRISE, 4.6.5 uses a UI default of 60 days and `limits.maxUsers` or a fallback of 20 users. The API error codes `ENTERPRISE_EXPIRY_LIMIT` and `ENTERPRISE_USER_LIMIT` are handled explicitly. These UI defaults do **not** establish the server's actual entitlement. Automated sales fail closed until server limits are present or an administrator records limits verified with the provider.

## Updates

`background.js` sends `POST /client/check-for-update` with `{version, token, device_id}`. `CURRENT_VERSION` comes from `chrome.runtime.getManifest().version`.

- `versionAction: update` with `updateMode: OPTIONAL` → optional notification.
- `versionAction: update` with any other mode → disable extension and show update.
- `versionAction: rollback` → forced notification/disable.
- Legacy `updateAvailable: true` without action → forced.
- `downloadLink` is accepted only over HTTPS.
- Target version is `targetVersion || latestVersion || version`.
- Popup has an upstream `/download` fallback.

The original API is outside these repositories. New panel publication does not change it. Managed extension 4.6.6 adds a separate wrapper for the update request; its configured channel sends **version only** to Supabase. All other existing API paths remain on GPT Yar. Without a configured channel it retains the upstream behavior. No Chrome automatic installation or Chrome Web Store update service is claimed.

## Live observations

On 2026-10-18, an HTTPS request to the validate endpoint with an intentionally invalid token and version 4.6.5 returned HTTP 403, `{error:"Invalid device token"}`. No real admin credentials, creation, renewal, deletion or destructive subscriber operation was performed. Successful live response shapes and the upstream acceptance of managed manifest version 4.6.6 still require a valid authorized test.

## Official sources used

- [Bale Bot API](https://docs.bale.ai/): `setWebhook`, `getWebhookInfo`, `sendInvoice`, `answerPreCheckoutQuery`, `SuccessfulPayment`, `inquireTransaction`.
- [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration)
- [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase signed uploads](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl)
- [Storage API implementation](https://github.com/supabase/storage-js/blob/master/src/packages/StorageFileApi.ts)
- [Supabase changelog](https://supabase.com/changelog): 2026 Data API grants change and PostgreSQL 17.11 security changes reviewed; no legacy pgcrypto ciphers are used.
