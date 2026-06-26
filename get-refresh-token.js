// One-shot helper to obtain a Spotify refresh token via the Authorization Code flow.
// Run:  node --env-file=.env get-refresh-token.js
// Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.
// Listens on http://127.0.0.1:8888/callback, captures the code, exchanges it,
// prints the refresh token, and offers to write it back into .env.

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";

const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "user-modify-playback-state user-read-playback-state";

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Run with: node --env-file=.env get-refresh-token.js",
  );
  process.exit(1);
}

const authorizeUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  });

async function exchangeCode(code) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `${res.status} ${data.error}: ${data.error_description || ""}`,
    );
  }
  return data;
}

async function saveToEnv(refreshToken) {
  const env = await readFile(".env", "utf8");
  const line = `SPOTIFY_REFRESH_TOKEN=${refreshToken}`;
  const updated = /^SPOTIFY_REFRESH_TOKEN=.*$/m.test(env)
    ? env.replace(/^SPOTIFY_REFRESH_TOKEN=.*$/m, line)
    : env.trimEnd() + "\n" + line + "\n";
  await writeFile(".env", updated);
  console.log("✅ Updated SPOTIFY_REFRESH_TOKEN in .env");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Error: ${error}`);
    console.error("Authorization denied:", error);
    server.close();
    return;
  }

  try {
    const tokens = await exchangeCode(code);
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end("Success! You can close this tab and return to the terminal.");
    console.log("\n✅ Refresh token obtained:\n");
    console.log(tokens.refresh_token);
    console.log("\nScopes granted:", tokens.scope || "(none reported)");
    await saveToEnv(tokens.refresh_token);
    console.log(
      "\nNext: update Vercel too →\n" +
        "  npx vercel env rm SPOTIFY_REFRESH_TOKEN production\n" +
        "  npx vercel env add SPOTIFY_REFRESH_TOKEN production   (paste the token above)\n" +
        "  npx vercel --prod --yes",
    );
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(err));
    console.error("\n❌ Token exchange failed:", err.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Callback server listening on", REDIRECT_URI);
  console.log("\n1. Make sure this Redirect URI is added in your Spotify app settings:");
  console.log("   " + REDIRECT_URI);
  console.log("\n2. Open this URL in your browser and approve:\n");
  console.log("   " + authorizeUrl + "\n");
});
