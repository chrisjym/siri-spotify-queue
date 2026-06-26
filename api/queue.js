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

// --- Search for Track ---
async function searchTrack(songName, accessToken) {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", songName);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "1");

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
  const track = data.tracks?.items?.[0];

  if (!track) {
    throw new Error(`No track found for: "${songName}"`);
  }

  return {
    uri: track.uri,
    name: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
  };
}

// --- Queue Track ---
async function queueTrack(trackUri, accessToken) {
  const url = new URL("https://api.spotify.com/v1/me/player/queue");
  url.searchParams.set("uri", trackUri);

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

  const { song } = req.body;

  if (!song || typeof song !== "string" || song.trim() === "") {
    return res
      .status(400)
      .json({ error: 'Missing or invalid "song" field in request body.' });
  }

  try {
    const accessToken = await refreshAccessToken();
    const track = await searchTrack(song.trim(), accessToken);
    await queueTrack(track.uri, accessToken);

    return res.status(200).json({
      success: true,
      queued: `${track.name} by ${track.artist}`,
    });
  } catch (err) {
    console.error("[queue.js error]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
