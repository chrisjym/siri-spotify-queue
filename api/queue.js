// Uses the global fetch built into Vercel's Node 18+ runtime.

// --- Token Refresh ---
async function refreshAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing required environment variables: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN",
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Token refresh failed: ${error.error_description || response.statusText}`,
    );
  }

  const data = await response.json();
  return data.access_token;
}

// Lowercase, strip diacritics and punctuation, collapse whitespace — so
// "Blinding Lights" matches "blinding lights" or "Blínding  Lights!".
function normalize(s) {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Rank a candidate's title against the (normalized) query. Higher is better.
function titleScore(trackName, normalizedQuery) {
  const name = normalize(trackName);
  if (name === normalizedQuery) return 3; // exact title
  if (normalizedQuery.includes(name)) return 2; // query "title artist" contains the title
  if (name.includes(normalizedQuery)) return 1; // title contains the query
  return 0;
}

// --- Search for Track ---
async function searchTrack(songName, accessToken) {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", songName);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "10");
  // Optionally pin results to a country for consistency/playability. Only sent
  // when SPOTIFY_MARKET is set (e.g. "US"); "from_token" is intentionally NOT
  // used as a default because it requires the user-read-private scope, which
  // this app's token does not have (Spotify returns 403 "Insufficient client
  // scope"). Title scoring below is what actually fixes wrong-track results.
  if (process.env.SPOTIFY_MARKET) {
    url.searchParams.set("market", process.env.SPOTIFY_MARKET);
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Search failed: ${error.error?.message || response.statusText}`,
    );
  }

  const data = await response.json();
  const items = data.tracks?.items || [];

  if (items.length === 0) {
    throw new Error(`No track found for: "${songName}"`);
  }

  // Spotify's top result is popularity-weighted and can return the wrong song
  // by the same artist. Prefer the best title match, tie-broken by popularity.
  const q = normalize(songName);
  const best = items.reduce((bestSoFar, candidate) => {
    const score = titleScore(candidate.name, q);
    const bestScore = titleScore(bestSoFar.name, q);
    if (score !== bestScore) return score > bestScore ? candidate : bestSoFar;
    return (candidate.popularity || 0) > (bestSoFar.popularity || 0)
      ? candidate
      : bestSoFar;
  });

  // If nothing matched the title at all, fall back to Spotify's top result.
  const track = titleScore(best.name, q) > 0 ? best : items[0];

  return {
    uri: track.uri,
    name: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
  };
}

// --- List Available Devices ---
async function getDevices(accessToken) {
  const response = await fetch(
    "https://api.spotify.com/v1/me/player/devices",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Device lookup failed: ${error.error?.message || response.statusText}`,
    );
  }

  const data = await response.json();
  return data.devices || [];
}

// --- Transfer Playback (re-activate a device) ---
// Spotify's queue endpoint only works against an *active* device. When a device
// goes idle, transferring playback to it re-activates the Connect session.
// play: false means "make it the active device but don't start playing".
async function transferPlayback(deviceId, accessToken) {
  const response = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Transfer playback failed: ${error.error?.message || response.statusText}`,
    );
  }
}

// --- Ensure an Active Device ---
// Returns the id of a device the queue can target. Uses the active device if
// there is one; otherwise re-activates the first available (last-used) device.
async function ensureActiveDevice(accessToken) {
  // Restricted devices can't be controlled via the Web API, so ignore them.
  const devices = (await getDevices(accessToken)).filter(
    (d) => !d.is_restricted,
  );

  if (devices.length === 0) {
    throw new Error(
      "No Spotify device found. Open the Spotify app on a phone, desktop, or speaker and try again.",
    );
  }

  const active = devices.find((d) => d.is_active);
  if (active) {
    return active.id;
  }

  // No active device, but one is available (app open but idle). Re-activate it.
  const target = devices[0];
  await transferPlayback(target.id, accessToken);
  return target.id;
}

// --- Queue Track ---
async function queueTrack(trackUri, accessToken, deviceId) {
  const url = new URL("https://api.spotify.com/v1/me/player/queue");
  url.searchParams.set("uri", trackUri);
  if (deviceId) {
    url.searchParams.set("device_id", deviceId);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Spotify documents 204 No Content, but in practice also returns 200 OK
  // (with a short body) for this endpoint. Treat any 2xx as success.
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Queue failed: ${error.error?.message || response.statusText}`,
    );
  }
}

// --- Main Handler ---
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Shared-secret gate. Only enforced when QUEUE_SECRET is configured, so the
  // function still works locally / in tests when it is unset.
  const secret = process.env.QUEUE_SECRET;
  if (secret && req.headers["x-queue-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { song } = req.body;

  if (!song || typeof song !== "string" || song.trim() === "") {
    return res
      .status(400)
      .json({ error: 'Missing or invalid "song" field in request body.' });
  }

  try {
    const accessToken = await refreshAccessToken();
    const track = await searchTrack(song.trim(), accessToken);
    const deviceId = await ensureActiveDevice(accessToken);
    await queueTrack(track.uri, accessToken, deviceId);

    return res.status(200).json({
      success: true,
      queued: `${track.name} by ${track.artist}`,
    });
  } catch (err) {
    console.error("[queue.js error]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
