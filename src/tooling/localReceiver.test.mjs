import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../../server/providers/live.js';
import {
  homeReceiverProxy,
  localReceiverUrl,
  normalizeReadsbAircraftResponse,
  receiverContacts,
  resetLocalReceiverForTests,
} from '../../server/providers/aircraft/local-receiver.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const RECEIVER_URL = 'http://192.0.2.10/tar1090/data/aircraft.json';

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

function isolate(t, values = {}) {
  resetLocalReceiverForTests();
  t.after(resetLocalReceiverForTests);
  t.mock.method(console, 'warn', () => {});
  environment(t, { GEV_LOCAL_READSB_URL: RECEIVER_URL, ...values });
}

/** Mount the plugin and call its route with a recording response double. */
async function request({ method = 'GET' } = {}) {
  const routes = new Map();
  homeReceiverProxy().configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  assert.ok(routes.has('/api/home-receiver'), 'mounts its own route');
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [key, value] of Object.entries(headers))
        this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
  let nextCalled = false;
  await routes.get('/api/home-receiver')({ url: '/', method }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled, json: res.body ? JSON.parse(res.body) : null };
}

const receiverPayload = {
  now: 1_700_000_010.4,
  messages: 1234,
  aircraft: [
    {
      hex: '4CA123',
      flight: 'EIN12 ',
      lat: 51.5,
      lon: -3.2,
      alt_baro: 12000,
      alt_geom: 12150,
      gs: 250,
      track: 271.5,
      category: 'A3',
      squawk: '7000',
      seen_pos: 0.4,
      seen: 0.1,
    },
    {
      hex: '400abc',
      lat: 51.7,
      lon: -3.1,
      alt_baro: 'ground',
      seen_pos: 1,
      seen: 1,
    },
    { hex: '406def', alt_baro: 30000, seen: 0.5 },
    { hex: '407000', lat: 52, lon: -3, alt_baro: 20000, seen_pos: 75, seen: 2 },
  ],
};

test('normalizes a readsb aircraft.json into OpenSky state vectors', () => {
  const normalized = normalizeReadsbAircraftResponse(receiverPayload);
  assert.equal(normalized.time, 1_700_000_010);
  assert.deepEqual(
    normalized.states.map((state) => state[0]),
    ['4ca123', '400abc'],
    'drops positionless rows and positions older than the freshness window',
  );
  assert.equal(
    normalized.states[0][3],
    1_700_000_009.6,
    'fix time is now minus seen_pos',
  );
  assert.equal(normalized.states[1][8], true, 'keeps grounded contacts');
});

test('normalizing tolerates malformed receiver payloads', () => {
  assert.deepEqual(normalizeReadsbAircraftResponse(null).states, []);
  assert.deepEqual(
    normalizeReadsbAircraftResponse({ now: 5, aircraft: 'nope' }).states,
    [],
  );
});

test('receiver contacts are plain objects in SI units', () => {
  const [airborne, grounded] = receiverContacts(
    normalizeReadsbAircraftResponse(receiverPayload).states,
  );
  assert.equal(airborne.icao24, '4ca123');
  assert.equal(airborne.callsign, 'EIN12');
  assert.equal(airborne.lat, 51.5);
  assert.equal(airborne.lon, -3.2);
  assert.ok(
    Math.abs(airborne.altitudeM - 12150 * 0.3048) < 0.01,
    'prefers geometric altitude',
  );
  assert.ok(Math.abs(airborne.speedMps - 250 * 0.514444) < 0.01);
  assert.equal(airborne.trackDeg, 271.5);
  assert.equal(airborne.category, 4);
  assert.equal(airborne.squawk, '7000');
  assert.equal(airborne.onGround, false);
  assert.equal(airborne.fixTime, 1_700_000_009.6);
  assert.equal(grounded.onGround, true);
  assert.equal(grounded.altitudeM, 0);
  assert.equal(grounded.callsign, null);
});

test('receiver URL must be an explicit http(s) URL from the environment', (t) => {
  isolate(t, { GEV_LOCAL_READSB_URL: undefined });
  assert.equal(localReceiverUrl(), null);
  process.env.GEV_LOCAL_READSB_URL = 'file:///etc/passwd';
  assert.equal(localReceiverUrl(), null);
  process.env.GEV_LOCAL_READSB_URL = '  ';
  assert.equal(localReceiverUrl(), null);
  process.env.GEV_LOCAL_READSB_URL = RECEIVER_URL;
  assert.equal(localReceiverUrl(), RECEIVER_URL);
});

test('serves the receiver aircraft without touching any other feed', async (t) => {
  isolate(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.ok(options.signal, 'receiver fetch has a timeout signal');
    return Response.json(receiverPayload);
  });
  const { res, json, nextCalled } = await request();
  assert.deepEqual(calls, [RECEIVER_URL]);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(json.time, 1_700_000_010);
  assert.deepEqual(
    json.aircraft.map((a) => a.icao24),
    ['4ca123', '400abc'],
  );
});

test('reports a missing or unreachable receiver honestly', async (t) => {
  isolate(t);
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const unreachable = await request();
  assert.equal(unreachable.res.statusCode, 502);
  assert.match(unreachable.json.error, /unreachable/i);

  delete process.env.GEV_LOCAL_READSB_URL;
  const missing = await request();
  assert.equal(missing.res.statusCode, 503);
  assert.match(missing.json.error, /GEV_LOCAL_READSB_URL/);
});

test('an unreachable receiver is not retried on every poll', async (t) => {
  isolate(t);
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    throw new TypeError('fetch failed');
  });
  await request();
  now += 5_000;
  assert.equal((await request()).res.statusCode, 502);
  assert.equal(
    attempts,
    1,
    'failure backs off instead of retrying immediately',
  );
  now += 60_000;
  await request();
  assert.equal(attempts, 2, 'retries once the backoff has passed');
});

test('snapshots are cached briefly and concurrent polls share one fetch', async (t) => {
  isolate(t);
  let now = 2_000_000;
  t.mock.method(Date, 'now', () => now);
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return Response.json(receiverPayload);
  });
  await Promise.all([request(), request()]);
  assert.equal(attempts, 1, 'concurrent requests coalesce');
  now += 500;
  await request();
  assert.equal(attempts, 1, 'fresh snapshot served from cache');
  now += 5_000;
  await request();
  assert.equal(attempts, 2, 'expired snapshot is refetched');
});

test('a non-OK receiver response is reported as unreachable', async (t) => {
  isolate(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('nope', { status: 503 }),
  );
  assert.equal((await request()).res.statusCode, 502);
});

test('non-GET requests pass through', async (t) => {
  isolate(t);
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('must not fetch');
  });
  const { nextCalled } = await request({ method: 'POST' });
  assert.equal(nextCalled, true);
});

test('is exported from the live entry and mounted with the local providers', () => {
  assert.equal(providers.homeReceiverProxy, homeReceiverProxy);
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.equal(
    names.filter((name) => name === 'home-receiver-proxy').length,
    1,
  );
  assert.equal(names.includes('local-receiver-merge'), false);
});
