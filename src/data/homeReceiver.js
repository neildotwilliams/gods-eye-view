import { CLASS_SCALE_2D, classifyAircraft } from './aircraftClass.js';

/**
 * Shared rules for the Wingbits home-receiver layer (fork addition).
 *
 * Colours follow wingbits.com: orange accent on near-black. The owned-contact
 * registry lets Live Flights drop an aircraft while the Wingbits layer is
 * showing it, mirroring how the Military layer suppresses its duplicates.
 */

/** Wingbits brand accent: aircraft glyphs and label text. */
export const WINGBITS_ORANGE = '#FF7121';
/** Wingbits brand background: label plates. */
export const WINGBITS_CHARCOAL = '#1E1B1B';

/** Cap on how far this layer extrapolates a contact past its last fix (seconds). */
export const HOME_RECEIVER_MAX_EXTRAPOLATION_S = 20;

const METRES_TO_FEET = 1 / 0.3048;
const EARTH_RADIUS_M = 6_371_000;

/** @type {Set<string>} Aircraft the active Wingbits layer is currently drawing. */
let _owned = new Set();

/**
 * Publish the aircraft the Wingbits layer is drawing.
 * @param {Iterable<string>} icao24s
 */
export function setHomeReceiverContacts(icao24s) {
  _owned = new Set([...icao24s].map((id) => String(id).toLowerCase()));
}

/** Release every aircraft (the layer was disabled or destroyed). */
export function clearHomeReceiverContacts() {
  _owned = new Set();
}

/**
 * @param {string} icao24
 * @returns {boolean} Whether the Wingbits layer is drawing this aircraft.
 */
export function homeReceiverOwns(icao24) {
  return _owned.has(String(icao24).toLowerCase());
}

/**
 * Short on-map label: callsign (or hex) plus flight level, or GND.
 * @param {{icao24:string, callsign:string|null, altitudeM:number|null, onGround:boolean}} contact
 * @returns {string}
 */
export function homeReceiverContactLabel(contact) {
  const name = contact.callsign || String(contact.icao24).toUpperCase();
  if (contact.onGround) return `${name} · GND`;
  if (!Number.isFinite(contact.altitudeM)) return name;
  const flightLevel = Math.max(
    0,
    Math.round((contact.altitudeM * METRES_TO_FEET) / 100),
  );
  return `${name} · FL${String(flightLevel).padStart(3, '0')}`;
}

/**
 * Glyph for a contact, from its ADS-B emitter category.
 * @param {{category:number|null}} contact
 * @returns {string} aircraftIcons kind.
 */
export function homeReceiverIconKind(contact) {
  return classifyAircraft({ category: contact.category });
}

/**
 * Per-class billboard size multiplier, shared with Live Flights
 * (`CLASS_SCALE_2D`) so a widebody or fastjet reads the same relative size
 * on both layers.
 * @param {{category:number|null}} contact
 * @returns {number}
 */
export function homeReceiverIconScale(contact) {
  return CLASS_SCALE_2D[homeReceiverIconKind(contact)] || 1;
}

/**
 * Dead-reckon a contact's position (and altitude) forward by `dtSeconds`,
 * using its last reported ground speed, track and vertical rate. A flat
 * (equirectangular) approximation is deliberately used: extrapolation is
 * capped at HOME_RECEIVER_MAX_EXTRAPOLATION_S, so curvature error stays
 * negligible over these distances. Grounded contacts still roll along their
 * track but never climb. A contact without usable motion data, or a
 * non-positive `dtSeconds`, is returned unchanged.
 * @param {{lat:number, lon:number, altitudeM:number|null, speedMps:number|null,
 *   trackDeg:number|null, verticalRateMps?:number|null, onGround?:boolean}} contact
 * @param {number} dtSeconds Seconds since the contact's fix.
 * @returns {{lat:number, lon:number, altitudeM:number|null}}
 */
export function homeReceiverDeadReckon(contact, dtSeconds) {
  const { lat, lon, altitudeM } = contact;
  const unchanged = { lat, lon, altitudeM };
  if (
    !Number.isFinite(contact.speedMps) ||
    contact.speedMps <= 0 ||
    !Number.isFinite(contact.trackDeg) ||
    !Number.isFinite(dtSeconds) ||
    dtSeconds <= 0 ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  )
    return unchanged;

  const dt = Math.min(dtSeconds, HOME_RECEIVER_MAX_EXTRAPOLATION_S);
  const distanceM = contact.speedMps * dt;
  const bearingRad = (contact.trackDeg * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;

  const dLat =
    ((distanceM * Math.cos(bearingRad)) / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon =
    ((distanceM * Math.sin(bearingRad)) / (EARTH_RADIUS_M * Math.cos(latRad))) *
    (180 / Math.PI);

  const climbedM =
    contact.onGround || !Number.isFinite(contact.verticalRateMps)
      ? altitudeM
      : (Number.isFinite(altitudeM) ? altitudeM : 0) +
        contact.verticalRateMps * dt;

  return { lat: lat + dLat, lon: lon + dLon, altitudeM: climbedM };
}
