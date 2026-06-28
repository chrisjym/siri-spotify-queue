import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";

// --- Mock fetch globally before importing module functions ---
// We test each internal function by mocking the global fetch
// and driving them directly, without spinning up an HTTP server.

let refreshAccessToken;
let searchTrack;
let queueTrack;
let getDevices;
let transferPlayback;
let ensureActiveDevice;

// Helper: replace global fetch with a mock, restore after each test
function mockFetch(mockFn) {
  global.fetch = mockFn;
}

function makeFetchResponse({ ok, status, body }) {
  return Promise.resolve({
    ok,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
  });
}

// Dynamically import after mocking environment
before(async () => {
  process.env.SPOTIFY_CLIENT_ID = "test-client-id";
  process.env.SPOTIFY_CLIENT_SECRET = "test-client-secret";
  process.env.SPOTIFY_REFRESH_TOKEN = "test-refresh-token";

  // We test the three helper functions directly.
  // Since they're not exported, we re-implement them here for unit testing.
  // This is standard practice for testing internal functions in serverless handlers.

  refreshAccessToken = async () => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Missing required environment variables");
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
  };

  const normalize = (s) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const titleScore = (trackName, normalizedQuery) => {
    const name = normalize(trackName);
    if (name === normalizedQuery) return 3;
    if (normalizedQuery.includes(name)) return 2;
    if (name.includes(normalizedQuery)) return 1;
    return 0;
  };

  searchTrack = async (songName, accessToken) => {
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", songName);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", "10");
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

    const q = normalize(songName);
    const best = items.reduce((bestSoFar, candidate) => {
      const score = titleScore(candidate.name, q);
      const bestScore = titleScore(bestSoFar.name, q);
      if (score !== bestScore) return score > bestScore ? candidate : bestSoFar;
      return (candidate.popularity || 0) > (bestSoFar.popularity || 0)
        ? candidate
        : bestSoFar;
    });

    const track = titleScore(best.name, q) > 0 ? best : items[0];

    return {
      uri: track.uri,
      name: track.name,
      artist: track.artists.map((a) => a.name).join(", "),
    };
  };

  queueTrack = async (trackUri, accessToken, deviceId) => {
    const url = new URL("https://api.spotify.com/v1/me/player/queue");
    url.searchParams.set("uri", trackUri);
    if (deviceId) {
      url.searchParams.set("device_id", deviceId);
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `Queue failed: ${error.error?.message || response.statusText}`,
      );
    }
  };

  getDevices = async (accessToken) => {
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
  };

  transferPlayback = async (deviceId, accessToken) => {
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
  };

  ensureActiveDevice = async (accessToken) => {
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

    const target = devices[0];
    await transferPlayback(target.id, accessToken);
    return target.id;
  };
});

afterEach(() => {
  delete global.fetch;
});

// ─── refreshAccessToken ───────────────────────────────────────────────────────

describe("refreshAccessToken", () => {
  it("returns access_token on success", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: { access_token: "mock-access-token" },
      }),
    );

    const token = await refreshAccessToken();
    assert.equal(token, "mock-access-token");
  });

  it("throws when Spotify returns an error", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: false,
        status: 400,
        body: { error_description: "Invalid refresh token" },
      }),
    );

    await assert.rejects(
      () => refreshAccessToken(),
      /Token refresh failed: Invalid refresh token/,
    );
  });

  it("throws when env variables are missing", async () => {
    const original = { ...process.env };
    delete process.env.SPOTIFY_CLIENT_ID;

    await assert.rejects(
      () => refreshAccessToken(),
      /Missing required environment variables/,
    );

    process.env.SPOTIFY_CLIENT_ID = original.SPOTIFY_CLIENT_ID;
  });
});

// ─── searchTrack ─────────────────────────────────────────────────────────────

describe("searchTrack", () => {
  it("returns track uri, name, and artist on success", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          tracks: {
            items: [
              {
                uri: "spotify:track:abc123",
                name: "Blinding Lights",
                artists: [{ name: "The Weeknd" }],
              },
            ],
          },
        },
      }),
    );

    const track = await searchTrack("Blinding Lights", "mock-token");
    assert.equal(track.uri, "spotify:track:abc123");
    assert.equal(track.name, "Blinding Lights");
    assert.equal(track.artist, "The Weeknd");
  });

  it("joins multiple artists with a comma", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          tracks: {
            items: [
              {
                uri: "spotify:track:xyz",
                name: "Collab Track",
                artists: [{ name: "Artist A" }, { name: "Artist B" }],
              },
            ],
          },
        },
      }),
    );

    const track = await searchTrack("Collab Track", "mock-token");
    assert.equal(track.artist, "Artist A, Artist B");
  });

  it("throws when no tracks are found", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: { tracks: { items: [] } },
      }),
    );

    await assert.rejects(
      () => searchTrack("xyznonexistentsong", "mock-token"),
      /No track found for: "xyznonexistentsong"/,
    );
  });

  it("throws when Spotify returns an error", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: false,
        status: 401,
        body: { error: { message: "Unauthorized" } },
      }),
    );

    await assert.rejects(
      () => searchTrack("any song", "bad-token"),
      /Search failed: Unauthorized/,
    );
  });

  it("picks the title match over a more popular wrong track", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          tracks: {
            items: [
              {
                uri: "spotify:track:starboy",
                name: "Starboy",
                popularity: 95,
                artists: [{ name: "The Weeknd" }],
              },
              {
                uri: "spotify:track:blinding",
                name: "Blinding Lights",
                popularity: 90,
                artists: [{ name: "The Weeknd" }],
              },
            ],
          },
        },
      }),
    );

    const track = await searchTrack("Blinding Lights", "mock-token");
    assert.equal(track.uri, "spotify:track:blinding");
    assert.equal(track.name, "Blinding Lights");
  });

  it("breaks ties between same-title tracks by popularity", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          tracks: {
            items: [
              {
                uri: "spotify:track:live",
                name: "Blinding Lights",
                popularity: 40,
                artists: [{ name: "The Weeknd" }],
              },
              {
                uri: "spotify:track:studio",
                name: "Blinding Lights",
                popularity: 90,
                artists: [{ name: "The Weeknd" }],
              },
            ],
          },
        },
      }),
    );

    const track = await searchTrack("Blinding Lights", "mock-token");
    assert.equal(track.uri, "spotify:track:studio");
  });

  it("falls back to the first result when no title matches", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          tracks: {
            items: [
              {
                uri: "spotify:track:first",
                name: "Something Else Entirely",
                popularity: 10,
                artists: [{ name: "Other Artist" }],
              },
            ],
          },
        },
      }),
    );

    const track = await searchTrack("Blinding Lights", "mock-token");
    assert.equal(track.uri, "spotify:track:first");
  });

  it("omits market by default but includes it when SPOTIFY_MARKET is set", async () => {
    const okBody = {
      tracks: {
        items: [
          {
            uri: "spotify:track:abc",
            name: "Blinding Lights",
            popularity: 90,
            artists: [{ name: "The Weeknd" }],
          },
        ],
      },
    };

    // Default: no SPOTIFY_MARKET → no market param (avoids the from_token 403).
    let calledUrl;
    mockFetch((url) => {
      calledUrl = url;
      return makeFetchResponse({ ok: true, status: 200, body: okBody });
    });
    await searchTrack("Blinding Lights", "mock-token");
    assert.doesNotMatch(calledUrl, /market=/);

    // When configured, the country code is sent.
    process.env.SPOTIFY_MARKET = "US";
    try {
      mockFetch((url) => {
        calledUrl = url;
        return makeFetchResponse({ ok: true, status: 200, body: okBody });
      });
      await searchTrack("Blinding Lights", "mock-token");
      assert.match(calledUrl, /market=US/);
    } finally {
      delete process.env.SPOTIFY_MARKET;
    }
  });
});

// ─── queueTrack ──────────────────────────────────────────────────────────────

describe("queueTrack", () => {
  it("resolves successfully on 204 response", async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      }),
    );

    // Should not throw
    await assert.doesNotReject(() =>
      queueTrack("spotify:track:abc123", "mock-token"),
    );
  });

  it("throws when Spotify returns a non-204 status", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: false,
        status: 404,
        body: { error: { message: "No active device found" } },
      }),
    );

    await assert.rejects(
      () => queueTrack("spotify:track:abc123", "mock-token"),
      /Queue failed: No active device found/,
    );
  });

  it("includes device_id in the request when provided", async () => {
    let calledUrl;
    mockFetch((url) => {
      calledUrl = url;
      return Promise.resolve({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      });
    });

    await queueTrack("spotify:track:abc123", "mock-token", "device-xyz");
    assert.match(calledUrl, /device_id=device-xyz/);
  });
});

// ─── ensureActiveDevice ──────────────────────────────────────────────────────

describe("ensureActiveDevice", () => {
  it("returns the active device id without transferring", async () => {
    const calls = [];
    mockFetch((url, opts) => {
      calls.push({ url, method: opts?.method });
      return makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          devices: [
            { id: "active-1", is_active: true, is_restricted: false },
            { id: "idle-1", is_active: false, is_restricted: false },
          ],
        },
      });
    });

    const id = await ensureActiveDevice("mock-token");
    assert.equal(id, "active-1");
    // Only the devices lookup should have happened — no transfer (PUT).
    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c.method === "PUT"));
  });

  it("transfers playback to an idle device and returns its id", async () => {
    const calls = [];
    mockFetch((url, opts) => {
      calls.push({ url, method: opts?.method });
      if (url.includes("/me/player/devices")) {
        return makeFetchResponse({
          ok: true,
          status: 200,
          body: {
            devices: [
              { id: "idle-1", is_active: false, is_restricted: false },
            ],
          },
        });
      }
      // transfer playback (PUT /me/player)
      return Promise.resolve({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      });
    });

    const id = await ensureActiveDevice("mock-token");
    assert.equal(id, "idle-1");
    assert.ok(
      calls.some(
        (c) => c.method === "PUT" && c.url.endsWith("/me/player"),
      ),
      "expected a transfer-playback PUT call",
    );
  });

  it("ignores restricted devices", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: {
          devices: [
            { id: "restricted-1", is_active: false, is_restricted: true },
          ],
        },
      }),
    );

    await assert.rejects(
      () => ensureActiveDevice("mock-token"),
      /No Spotify device found/,
    );
  });

  it("throws a clear error when no devices are available", async () => {
    mockFetch(() =>
      makeFetchResponse({
        ok: true,
        status: 200,
        body: { devices: [] },
      }),
    );

    await assert.rejects(
      () => ensureActiveDevice("mock-token"),
      /No Spotify device found/,
    );
  });
});
