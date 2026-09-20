import test from 'node:test';
import assert from 'node:assert/strict';
import * as providers from '../../server/providers/live.js';
import {
  normalizePowerCutRecord,
  normalizePowerCutsResponse,
  powerCutsProxy,
} from '../../server/providers/powerCuts.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const SOUTH_WALES_RECORD = {
  'Upload Date': '2026-09-19T19:49:00',
  Region: 'South Wales',
  'Incident ID': 'INCD-60047-f',
  'Confirmed Off': 24,
  'Predicted Off': 0,
  Restored: 13,
  Status: 'Awaiting',
  Planned: 'false',
  Category: 'HV OVERHEAD',
  'Resource Status': 'UNASSIGNED',
  'Start Time': '2026-09-19T17:58:00',
  ETR: '2026-09-19T20:30:00',
  Voltage: 'HV',
  'Location Latitude': 51.78978,
  'Location Longitude': -4.119541,
  Postcodes: 'SA32 8PY, SA15 5BL',
};

function ckanResponse(records) {
  return { success: true, result: { records } };
}

/** Mount the plugin and call its route with a recording response double. */
async function request({ method = 'GET' } = {}) {
  const routes = new Map();
  powerCutsProxy().configureServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  assert.ok(routes.has('/api/power-cuts'), 'mounts its own route');
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
  await routes.get('/api/power-cuts')({ method }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled, json: res.body ? JSON.parse(res.body) : null };
}

test('normalizes a CKAN record into a plain incident', () => {
  const incident = normalizePowerCutRecord(SOUTH_WALES_RECORD);
  assert.equal(incident.id, 'INCD-60047-f');
  assert.equal(incident.region, 'South Wales');
  assert.equal(incident.status, 'Awaiting');
  assert.equal(incident.planned, false);
  assert.equal(incident.category, 'HV OVERHEAD');
  assert.equal(incident.voltage, 'HV');
  assert.equal(incident.confirmedOff, 24);
  assert.equal(incident.predictedOff, 0);
  assert.equal(incident.restored, 13);
  assert.equal(incident.startTime, '2026-09-19T17:58:00');
  assert.equal(incident.etr, '2026-09-19T20:30:00');
  assert.equal(incident.lat, 51.78978);
  assert.equal(incident.lon, -4.119541);
  assert.equal(incident.postcodes, 'SA32 8PY, SA15 5BL');
});

test('a record without a position is dropped', () => {
  assert.equal(
    normalizePowerCutRecord({
      ...SOUTH_WALES_RECORD,
      'Location Latitude': null,
    }),
    null,
  );
  assert.equal(normalizePowerCutRecord({}), null);
});

test('a missing incident id falls back to a stable position-based one', () => {
  const incident = normalizePowerCutRecord({
    ...SOUTH_WALES_RECORD,
    'Incident ID': '',
  });
  assert.equal(incident.id, 'pc-51.7898--4.1195');
});

test('planned is read from the CKAN boolean-as-string convention', () => {
  assert.equal(
    normalizePowerCutRecord({ ...SOUTH_WALES_RECORD, Planned: 'true' }).planned,
    true,
  );
  assert.equal(
    normalizePowerCutRecord({ ...SOUTH_WALES_RECORD, Planned: 'false' })
      .planned,
    false,
  );
});

test('response normalization drops malformed input to an empty list, never throws', () => {
  assert.deepEqual(normalizePowerCutsResponse(null).incidents, []);
  assert.deepEqual(normalizePowerCutsResponse({ result: {} }).incidents, []);
  assert.deepEqual(
    normalizePowerCutsResponse({ result: { records: 'nope' } }).incidents,
    [],
  );
});

test('serves normalized incidents from a fresh fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /connecteddata\.nationalgrid\.co\.uk/);
    assert.ok(options.signal, 'has a timeout signal');
    return Response.json(ckanResponse([SOUTH_WALES_RECORD]));
  });
  const { res, json } = await request();
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-power-cuts-cache'], 'MISS');
  assert.equal(json.incidents.length, 1);
  assert.equal(json.incidents[0].region, 'South Wales');
});

test('caches briefly and serves stale on a later upstream failure', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return Response.json(ckanResponse([SOUTH_WALES_RECORD]));
    throw new TypeError('fetch failed');
  });

  const routes = new Map();
  const plugin = powerCutsProxy();
  plugin.configureServer({ middlewares: { use: (r, h) => routes.set(r, h) } });
  const call = async () => {
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(s, h = {}) {
        this.statusCode = s;
        for (const [k, v] of Object.entries(h))
          this.headers[k.toLowerCase()] = v;
      },
      end(b) {
        this.body = b;
      },
    };
    await routes.get('/api/power-cuts')({ method: 'GET' }, res, () => {});
    return res;
  };

  const first = await call();
  assert.equal(first.headers['x-power-cuts-cache'], 'MISS');
  assert.equal(calls, 1);

  now += 30_000;
  const cached = await call();
  assert.equal(cached.headers['x-power-cuts-cache'], 'HIT');
  assert.equal(calls, 1, 'still within the cache window');

  now += 3 * 60_000; // past CACHE_MS
  const stale = await call();
  assert.equal(calls, 2, 'cache expired, upstream retried');
  assert.equal(stale.headers['x-power-cuts-cache'], 'STALE');
  assert.equal(
    JSON.parse(stale.body).incidents.length,
    1,
    'serves the last-good data',
  );
});

test('an unreachable upstream with no prior cache reports 502, never throws', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  const { res, json } = await request();
  assert.equal(res.statusCode, 502);
  assert.match(json.error, /unreachable/i);
});

test('a non-JSON or unsuccessful CKAN response is treated as a failure', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ success: false }),
  );
  const { res } = await request();
  assert.equal(res.statusCode, 502);
});

test('non-GET requests pass through', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('must not fetch');
  });
  const { nextCalled } = await request({ method: 'POST' });
  assert.equal(nextCalled, true);
});

test('is exported from the live entry and mounted with the local providers', () => {
  assert.equal(providers.powerCutsProxy, powerCutsProxy);
  const names = localProviderPlugins().map((plugin) => plugin.name);
  assert.equal(names.filter((name) => name === 'power-cuts-proxy').length, 1);
});
