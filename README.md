# Siri Spotify Queue

A small Vercel serverless function that adds a song to your Spotify playback
queue. Designed to be called from an iOS Siri Shortcut: say a song name, and it
gets queued on your active Spotify device.

## How it works

`POST /api/queue` with a JSON body:

```bash
curl -X POST "https://siri-spotify-queue.vercel.app/api/queue" \
  -H "Content-Type: application/json" \
  -d '{"song": "Blinding Lights The Weeknd"}'
```

Success response:

```json
{ "success": true, "queued": "Blinding Lights by The Weeknd" }
```

The handler ([api/queue.js](api/queue.js)) does three things:

1. **Refresh the access token** using the long-lived `SPOTIFY_REFRESH_TOKEN`.
2. **Search** for the track and take the top result.
3. **Queue** the track on the user's currently active device.

> **Note:** Spotify can only queue to an *active device*. Something must be
> playing (or have recently played) on Spotify, or the call returns
> `Queue failed: Not Found`.

## Environment variables

Set these locally in `.env` and in the Vercel project settings (Production +
Preview):

| Variable                 | Where to get it                                   |
| ------------------------ | ------------------------------------------------- |
| `SPOTIFY_CLIENT_ID`      | Spotify Developer Dashboard → your app            |
| `SPOTIFY_CLIENT_SECRET`  | Spotify Developer Dashboard → your app            |
| `SPOTIFY_REFRESH_TOKEN`  | Generated via the Authorization Code flow (below) |

### Generating a refresh token

Use the helper script — it runs the full OAuth flow locally and writes the
token into `.env`:

```bash
node --env-file=.env get-refresh-token.js
```

It listens on `http://127.0.0.1:8888/callback` (add that exact URI to your
Spotify app's Redirect URIs first), prints an authorize URL to open, captures
the code, exchanges it, and saves the resulting refresh token.

## Runtime

Uses the **global `fetch`** built into the Vercel Node.js runtime (Node 18+).
No HTTP-client dependency is required.

## Tests

```bash
npm test
```

---

## Troubleshooting / Bug history

This project hit four distinct failures before working end-to-end. Documented
here because each one masked the next, and the symptoms were misleading.

### 1. `Redirecting...` instead of JSON

**Symptom:** `curl` to the deployment returned an HTML `Redirecting...` page,
never the function's JSON.

**Cause:** **Vercel Deployment Protection** (Vercel Authentication). Requests
were intercepted *before* reaching the function and `302`-redirected to a
`vercel.com/sso-api` login page. `curl` (and Siri Shortcuts) can't complete an
SSO login, so they only ever saw the redirect.

```
HTTP/2 302
location: https://vercel.com/sso-api?url=...
```

**Fix:** Vercel dashboard → **Settings → Deployment Protection** → disable
**Vercel Authentication**. Also prefer the stable production alias
(`siri-spotify-queue.vercel.app`) over the per-deployment hashed URLs, which are
protected by default.

### 2. `FUNCTION_INVOCATION_FAILED` (`ERR_REQUIRE_ESM`)

**Symptom:** After disabling protection, the function 500'd with
`FUNCTION_INVOCATION_FAILED`. Vercel logs showed `Error [ERR_REQUIRE_ESM]`.

**Cause:** The code imported `node-fetch` **v3**, which is pure ESM. Vercel's
Node builder ended up `require()`-ing it, and a CommonJS `require()` of a
pure-ESM module throws `ERR_REQUIRE_ESM`, crashing the function on load.

**Fix:** Removed `node-fetch` entirely and switched to the **global `fetch`**
available in the Vercel Node 18+ runtime. The dependency was deleted from
`package.json` and the lockfile.

### 3. `Token refresh failed: Invalid refresh token`

**Symptom:** The function ran and returned proper JSON, but Spotify rejected the
credentials with `Invalid refresh token`.

**Cause:** The `SPOTIFY_REFRESH_TOKEN` was a **web-player-scraped token** (it
contained a `&ubi=...` payload), not an OAuth token issued by the Authorization
Code flow. Web-player tokens are bound to Spotify's own client and are not valid
against `accounts.spotify.com/api/token` with your app's `client_id` /
`client_secret`.

A valid refresh token is a single opaque string — no `&ubi=`, no query-string
payload — granted with the `user-modify-playback-state` scope.

**Fix:** Generated a correct token via the Authorization Code flow using
[get-refresh-token.js](get-refresh-token.js), then updated `SPOTIFY_REFRESH_TOKEN`
in `.env` **and** in Vercel (Production + Preview), and redeployed.

> Vercel env var changes only take effect on a **new deployment** — redeploy
> after updating them. Also, `vercel env pull` returns empty values for
> sensitive variables, so it can't be used to verify them; only a live request
> can.

### 4. `Queue failed: OK`

**Symptom:** Token and search worked, but the queue step failed with the odd
message `Queue failed: OK` — even though the song *was* actually queued.

**Cause:** The success check was `if (response.status !== 204)`. Spotify
documents `204 No Content` for this endpoint but in practice returns **`200 OK`**
(with a short body) for some accounts. A successful `200` was treated as a
failure, and `response.statusText` ("OK") became the error message.

**Fix:** Accept any 2xx response instead of exactly `204`:

```js
// before
if (response.status !== 204) { /* throw */ }
// after
if (!response.ok) { /* throw */ }
```

### Summary

| # | Symptom                          | Root cause                                   | Fix                                      |
| - | -------------------------------- | -------------------------------------------- | ---------------------------------------- |
| 1 | `Redirecting...` HTML            | Vercel Deployment Protection (SSO)           | Disable protection; use production alias |
| 2 | `FUNCTION_INVOCATION_FAILED`     | `require()` of pure-ESM `node-fetch` v3      | Use global `fetch`; drop `node-fetch`    |
| 3 | `Invalid refresh token`          | Web-player token, not an OAuth token         | Regenerate via Authorization Code flow   |
| 4 | `Queue failed: OK`               | Success check too strict (only `204`)        | Accept any 2xx (`!response.ok`)          |
