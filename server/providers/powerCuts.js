import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';

/**
 * National Grid Electricity Distribution (NGED) live power cuts proxy.
 *
 * GET /api/power-cuts. NGED is the DNO for the Midlands, South West England
 * and South Wales; its "Live Power Cuts" CKAN dataset is genuinely open —
 * no key, no registration — but sends no CORS headers, so the browser can't
 * fetch it directly. This proxy fetches it server-side, normalizes CKAN's
 * column-named records into plain objects, and caches briefly (the upstream
 * itself only refreshes every few minutes).
 */

const UPSTREAM_URL =
  'https://connecteddata.nationalgrid.co.uk/api/3/action/datastore_search' +
  '?resource_id=292f788f-4339-455b-8cc0-153e14509d4d&limit=2000';
const CACHE_MS = 2 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Normalize one CKAN record into a plain incident object. Records without a
 * usable position are dropped — there is nowhere to draw them.
 * @param {object} record One row from the CKAN datastore_search response.
 * @returns {object|null}
 */
export function normalizePowerCutRecord(record) {
  const num = (value) => (Number.isFinite(value) ? value : null);
  const lat = num(record?.['Location Latitude']);
  const lon = num(record?.['Location Longitude']);
  if (lat === null || lon === null) return null;
  const text = (value) => {
    const trimmed = String(value ?? '').trim();
    return trimmed || null;
  };
  return {
    id:
      text(record?.['Incident ID']) || `pc-${lat.toFixed(4)}-${lon.toFixed(4)}`,
    region: text(record?.Region),
    status: text(record?.Status),
    planned: record?.Planned === 'true' || record?.Planned === true,
    category: text(record?.Category),
    voltage: text(record?.Voltage),
    confirmedOff: num(record?.['Confirmed Off']) ?? 0,
    predictedOff: num(record?.['Predicted Off']) ?? 0,
    restored: num(record?.Restored) ?? 0,
    startTime: text(record?.['Start Time']),
    etr: text(record?.ETR),
    lat,
    lon,
    postcodes: text(record?.Postcodes),
  };
}

/**
 * Normalize a full CKAN datastore_search response.
 * @param {object} payload Parsed CKAN JSON body.
 * @returns {{time:number, incidents:Array<object>}}
 */
export function normalizePowerCutsResponse(payload) {
  const records = Array.isArray(payload?.result?.records)
    ? payload.result.records
    : [];
  return {
    time: Math.floor(Date.now() / 1000),
    incidents: records.map(normalizePowerCutRecord).filter(Boolean),
  };
}

/** Send a JSON response with no-store caching. */
function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/**
 * Vite plugin: National Grid live power cuts at GET /api/power-cuts.
 * @returns {import('vite').Plugin}
 */
export function powerCutsProxy() {
  /** @type {{normalized: object, fetchedAt: number}|null} */
  let cache = null;
  const inflight = new Map();

  async function fetchUpstream() {
    const request = coalesceProxyRequest(inflight, 'power-cuts', async () => {
      const upstream = await fetch(UPSTREAM_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      const payload = await readResponseJsonCapped(
        upstream,
        MAX_RESPONSE_BYTES,
      );
      if (payload?.success !== true)
        throw new Error('upstream reported failure');
      return normalizePowerCutsResponse(payload);
    });
    try {
      const normalized = await request.promise;
      cache = { normalized, fetchedAt: Date.now() };
      return cache;
    } catch (error) {
      if (!request.shared) {
        console.warn(
          '[power-cuts-proxy] refresh failed:',
          error?.message || error,
        );
      }
      return null;
    }
  }

  return {
    name: 'power-cuts-proxy',
    configureServer(server) {
      server.middlewares.use('/api/power-cuts', async (req, res, next) => {
        if (req.method !== 'GET') return next?.();
        const now = Date.now();
        if (cache && now - cache.fetchedAt < CACHE_MS) {
          sendJson(res, 200, cache.normalized, { 'X-Power-Cuts-Cache': 'HIT' });
          return;
        }
        const fresh = await fetchUpstream();
        if (fresh) {
          sendJson(res, 200, fresh.normalized, {
            'X-Power-Cuts-Cache': 'MISS',
          });
        } else if (cache) {
          sendJson(res, 200, cache.normalized, {
            'X-Power-Cuts-Cache': 'STALE',
          });
        } else {
          sendJson(res, 502, {
            error: 'National Grid power cuts feed unreachable',
          });
        }
      });
    },
  };
}
