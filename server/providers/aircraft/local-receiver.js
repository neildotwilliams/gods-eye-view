import { normalizeAdsbLolAircraftState } from '../../../src/data/adsbLolFallback.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
} from '../common/http.js';

/**
 * Home ADS-B receiver proxy: GET /api/home-receiver.
 *
 * Serves the aircraft from the operator's own readsb/tar1090 `aircraft.json`
 * (GEV_LOCAL_READSB_URL, e.g. http://<pi>/tar1090/data/aircraft.json) for the
 * browser's Wingbits layer. No other feed is contacted. 503 when no receiver is
 * configured, 502 when it is unreachable. The URL comes only from server
 * configuration; clients cannot supply it.
 */

/** Positions older than this (seconds) are dropped from the receiver feed. */
const RECEIVER_MAX_POSITION_AGE_S = 60;
/** readsb rewrites aircraft.json every second; brief caching absorbs bursts. */
const RECEIVER_CACHE_MS = 2000;
/** After a failure, wait this long before contacting the receiver again. */
const RECEIVER_FAILURE_BACKOFF_MS = 30_000;
const RECEIVER_TIMEOUT_MS = 3000;
const RECEIVER_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** @type {{states:Array[], time:number, fetchedAt:number}|null} */
let _snapshot = null;
let _retryAfter = 0;
let _warned = false;
const _inFlight = new Map();

/** Clear process state between tests. */
export function resetLocalReceiverForTests() {
  _snapshot = null;
  _retryAfter = 0;
  _warned = false;
  _inFlight.clear();
}

/**
 * The configured receiver URL, or null when unset or not http(s).
 * @returns {string|null}
 */
export function localReceiverUrl() {
  const raw = String(process.env.GEV_LOCAL_READSB_URL || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw;
  } catch {
    /* invalid URL: fall through to the warning */
  }
  if (!_warned) {
    console.warn(
      '[Local Receiver] GEV_LOCAL_READSB_URL must be an http(s) URL; ignoring it',
    );
    _warned = true;
  }
  return null;
}

/**
 * Convert a readsb `aircraft.json` into OpenSky state vectors.
 * Positionless rows and positions older than a minute are excluded.
 * @param {object} payload readsb aircraft.json document.
 * @returns {{time:number, states:Array[]}}
 */
export function normalizeReadsbAircraftResponse(payload) {
  const now = Number(payload?.now);
  const nowSeconds = Math.floor(Number.isFinite(now) ? now : Date.now() / 1000);
  const aircraft = Array.isArray(payload?.aircraft) ? payload.aircraft : [];
  const states = aircraft
    .filter((row) => !(Number(row?.seen_pos) > RECEIVER_MAX_POSITION_AGE_S))
    .map((row) => normalizeAdsbLolAircraftState(row, nowSeconds))
    .filter(Boolean);
  return { time: nowSeconds, states };
}

async function fetchReceiverStates(url) {
  const now = Date.now();
  if (_snapshot && now - _snapshot.fetchedAt < RECEIVER_CACHE_MS)
    return _snapshot.states;
  if (now < _retryAfter) return null;

  const request = coalesceProxyRequest(_inFlight, url, async () => {
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
    });
    if (!upstream.ok) throw new Error(`receiver HTTP ${upstream.status}`);
    const payload = await readResponseJsonCapped(
      upstream,
      RECEIVER_MAX_RESPONSE_BYTES,
    );
    return normalizeReadsbAircraftResponse(payload);
  });
  try {
    const { time, states } = await request.promise;
    _snapshot = { states, time, fetchedAt: Date.now() };
    _retryAfter = 0;
    _warned = false;
    return states;
  } catch (error) {
    _snapshot = null;
    _retryAfter = Date.now() + RECEIVER_FAILURE_BACKOFF_MS;
    if (!request.shared && !_warned) {
      console.warn(
        '[Local Receiver] unavailable, retrying in 30 s:',
        error?.message || error,
      );
      _warned = true;
    }
    return null;
  }
}

/**
 * Convert receiver state vectors into plain contacts for the browser layer.
 * Altitude prefers geometric height, falling back to barometric; grounded
 * contacts report 0 m.
 * @param {Array[]} states OpenSky-shaped receiver state vectors.
 * @returns {Array<object>}
 */
export function receiverContacts(states) {
  const num = (value) => (Number.isFinite(value) ? value : null);
  return states.map((state) => {
    const onGround = state[8] === true;
    return {
      icao24: state[0],
      callsign: state[1] || null,
      fixTime: num(state[3]),
      lat: state[6],
      lon: state[5],
      onGround,
      altitudeM: onGround ? 0 : (num(state[13]) ?? num(state[7])),
      speedMps: num(state[9]),
      trackDeg: num(state[10]),
      verticalRateMps: num(state[11]),
      squawk: state[14] || null,
      category: num(state[17]),
    };
  });
}

/** Send a JSON response with no-store caching. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * Vite plugin: the home receiver's aircraft at GET /api/home-receiver.
 * @returns {import('vite').Plugin}
 */
export function homeReceiverProxy() {
  return {
    name: 'home-receiver-proxy',
    configureServer(server) {
      server.middlewares.use('/api/home-receiver', async (req, res, next) => {
        if (req.method !== 'GET') return next?.();
        const url = localReceiverUrl();
        if (!url) {
          sendJson(res, 503, {
            error: 'No home receiver configured (set GEV_LOCAL_READSB_URL)',
          });
          return;
        }
        const states = await fetchReceiverStates(url);
        if (!states) {
          sendJson(res, 502, { error: 'Home receiver unreachable' });
          return;
        }
        sendJson(res, 200, {
          time: _snapshot?.time ?? Math.floor(Date.now() / 1000),
          aircraft: receiverContacts(states),
        });
      });
    },
  };
}
