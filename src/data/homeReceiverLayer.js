import * as Cesium from 'cesium';
import { aircraftIcon } from './aircraftIcons.js';
import {
  WINGBITS_CHARCOAL,
  WINGBITS_ORANGE,
  clearHomeReceiverContacts,
  homeReceiverContactLabel,
  homeReceiverDeadReckon,
  homeReceiverIconKind,
  homeReceiverIconScale,
  setHomeReceiverContacts,
} from './homeReceiver.js';
import {
  bindTrackingClickGesture,
  isTrackingSelectionGesture,
} from './trackingClickGesture.js';
import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import {
  refreshWingbitsContact,
  showWingbitsContact,
  shownWingbitsContact,
} from '../wingbitsContactPanel.js';
import { governorRequestRender } from '../renderGovernor.js';

/**
 * Wingbits (Home): aircraft heard by the operator's own ADS-B receiver
 * (fork addition). Polls the server's /api/home-receiver, which reads the
 * receiver's readsb feed and nothing else, so with Live Flights off this is
 * the only aircraft traffic the browser handles: a few dozen primitives,
 * about a kilobyte per poll.
 *
 * Deliberately lightweight, for a low-powered laptop: glyphs are nudged
 * along their last reported track and vertical rate once a second between
 * 3 s polls (dead reckoning, see homeReceiver.js) rather than held under a
 * continuous 60fps render — one `governorRequestRender` per second while
 * enabled, not a `holdContinuousRender` like Live Flights. There is still no
 * 3D model or cockpit view; this layer trades perfect smoothness for cost.
 *
 * Clicking a contact opens a details box (`wingbitsContactPanel.js`), the
 * same idea as the CCTV viewer's popup. While enabled it publishes the
 * aircraft it draws so Live Flights hides its own copies (see homeReceiver.js).
 */

const LAYER_ID = 'home-receiver';
const API_URL = '/api/home-receiver';
const ORANGE = Cesium.Color.fromCssColorString(WINGBITS_ORANGE);
const CHARCOAL =
  Cesium.Color.fromCssColorString(WINGBITS_CHARCOAL).withAlpha(0.85);
const ICON_SCALE = new Cesium.NearFarScalar(1.0e4, 1.2, 2.0e6, 0.6);
const LABEL_SCALE = new Cesium.NearFarScalar(1.0e4, 1.0, 2.0e6, 0.7);
/** Base billboard size (px) at 1x — multiplied by the per-class scale below. */
const BASE_ICON_PX = 22;
/** Interpolation cadence between polls — a request, not a render hold. */
const INTERPOLATION_TICK_MS = 1000;

export function createHomeReceiverLayer({
  fetchImpl = (...args) => fetch(...args),
  screenSpaceEventHandlerFactory = (canvas) =>
    new Cesium.ScreenSpaceEventHandler(canvas),
  showContact = showWingbitsContact,
  refreshContact = refreshWingbitsContact,
  shownContact = shownWingbitsContact,
  createBillboardCollection = () => new Cesium.BillboardCollection(),
  createLabelCollection = () => new Cesium.LabelCollection(),
} = {}) {
  let _viewer = null;
  let _billboards = null;
  let _labels = null;
  /** @type {Map<string, {billboard:object, label:object, contact:object, observedAtMs:number}>} */
  const _drawn = new Map();
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _clickHandler = null;
  let _tickTimer = null;

  function clearDrawn() {
    _billboards?.removeAll();
    _labels?.removeAll();
    _drawn.clear();
  }

  function positionFor(contact) {
    return Cesium.Cartesian3.fromDegrees(
      contact.lon,
      contact.lat,
      Number.isFinite(contact.altitudeM) ? contact.altitudeM : 0,
    );
  }

  function draw(contacts) {
    const now = Date.now();
    const seen = new Set();
    for (const contact of contacts) {
      if (!Number.isFinite(contact.lat) || !Number.isFinite(contact.lon))
        continue;
      seen.add(contact.icao24);
      const position = positionFor(contact);
      const rotation = Number.isFinite(contact.trackDeg)
        ? -Cesium.Math.toRadians(contact.trackDeg)
        : 0;
      const image = aircraftIcon(homeReceiverIconKind(contact));
      const text = homeReceiverContactLabel(contact);
      const sizePx = BASE_ICON_PX * homeReceiverIconScale(contact);
      const existing = _drawn.get(contact.icao24);
      if (existing) {
        existing.billboard.position = position;
        existing.billboard.rotation = rotation;
        existing.billboard.width = sizePx;
        existing.billboard.height = sizePx;
        if (existing.billboard.image !== image)
          existing.billboard.image = image;
        existing.label.position = position;
        existing.label.text = text;
        existing.contact = contact;
        existing.observedAtMs = now;
        continue;
      }
      _drawn.set(contact.icao24, {
        contact,
        observedAtMs: now,
        billboard: _billboards.add({
          id: contact.icao24,
          position,
          image,
          width: sizePx,
          height: sizePx,
          color: ORANGE,
          rotation,
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          scaleByDistance: ICON_SCALE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
        label: _labels.add({
          id: contact.icao24,
          position,
          text,
          font: '12px "JetBrains Mono", monospace',
          fillColor: ORANGE,
          showBackground: true,
          backgroundColor: CHARCOAL,
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          pixelOffset: new Cesium.Cartesian2(16, 0),
          scaleByDistance: LABEL_SCALE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      });
    }
    for (const [icao24, drawn] of _drawn) {
      if (seen.has(icao24)) continue;
      _billboards.remove(drawn.billboard);
      _labels.remove(drawn.label);
      _drawn.delete(icao24);
    }
    setHomeReceiverContacts(_drawn.keys());

    // Keep an open details box live, and close it if its aircraft dropped
    // off the feed — mirrors flights.js's tracked-readout STALE handling,
    // simplified since this layer has no tracking, only a details popup.
    const openIcao24 = shownContact();
    if (openIcao24)
      refreshContact(openIcao24, _drawn.get(openIcao24)?.contact ?? null);
  }

  /**
   * Nudge every drawn contact along its last-known track/vertical-rate,
   * using elapsed CLIENT time since it was drawn — deliberately not the
   * receiver's own fix timestamp, which would need Pi/browser clocks to
   * agree. The next poll's `draw()` always re-anchors to the true fix, so
   * this only smooths the gap between polls, never accumulates drift, and
   * is skipped entirely for a contact with no usable speed/track.
   */
  function interpolateTick() {
    if (!_enabled || _drawn.size === 0) return;
    const now = Date.now();
    let moved = false;
    for (const entry of _drawn.values()) {
      const dtSeconds = (now - entry.observedAtMs) / 1000;
      if (!(dtSeconds > 0)) continue;
      const next = homeReceiverDeadReckon(entry.contact, dtSeconds);
      if (next.lat === entry.contact.lat && next.lon === entry.contact.lon) {
        continue; // no motion data for this contact
      }
      const position = positionFor({ ...entry.contact, ...next });
      entry.billboard.position = position;
      entry.label.position = position;
      moved = true;
    }
    if (moved) governorRequestRender(`layer-tick:${LAYER_ID}`);
  }

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = screenSpaceEventHandlerFactory(viewer.scene.canvas);
    bindTrackingClickGesture(_clickHandler, (click, gesture) => {
      if (!isTrackingSelectionGesture(gesture)) return;
      if (
        typeof document !== 'undefined' &&
        document.body?.classList?.contains('cockpit-mode')
      )
        return;
      const picked = viewer.scene.pick(click.position);
      if (!picked) return;
      const pickedId = resolvePickId(picked);
      const entry = pickedId ? _drawn.get(pickedId) : null;
      if (entry)
        showContact(entry.contact, {
          x: click.position.x,
          y: click.position.y,
        });
    });
  }

  const layer = {
    id: LAYER_ID,
    name: 'Wingbits (Home)',
    icon: '📡',
    source: 'Wingbits receiver',
    updateInterval: 3000,

    init(viewer) {
      _viewer = viewer;
      _billboards = createBillboardCollection();
      _labels = createLabelCollection();
      _billboards.show = false;
      _labels.show = false;
      viewer.scene.primitives.add(_billboards);
      viewer.scene.primitives.add(_labels);
      installClickHandler(viewer);
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
    },

    enable() {
      _enabled = true;
      _billboards.show = true;
      _labels.show = true;
      registerPickOwner(LAYER_ID, (pickedId) => _drawn.has(pickedId));
      if (!_tickTimer) {
        _tickTimer = setInterval(interpolateTick, INTERPOLATION_TICK_MS);
      }
    },

    disable() {
      _enabled = false;
      _billboards.show = false;
      _labels.show = false;
      if (_tickTimer) {
        clearInterval(_tickTimer);
        _tickTimer = null;
      }
      unregisterPickOwner(LAYER_ID);
      clearDrawn();
      clearHomeReceiverContacts();
    },

    async update() {
      try {
        const response = await fetchImpl(API_URL, {
          headers: { Accept: 'application/json' },
        });
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (!response.ok) {
          _lastError = body?.error || `Receiver HTTP ${response.status}`;
          return false;
        }
        if (!Array.isArray(body?.aircraft)) {
          _lastError = 'Malformed receiver response';
          return false;
        }
        if (!_enabled) return true;
        draw(body.aircraft);
        _lastUpdate = Number.isFinite(body.time)
          ? body.time * 1000
          : Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        console.warn('[Data:HomeReceiver] Fetch error:', error);
        _lastError = 'Receiver network error';
        return false;
      }
    },

    destroy(viewer) {
      if (_tickTimer) {
        clearInterval(_tickTimer);
        _tickTimer = null;
      }
      unregisterPickOwner(LAYER_ID);
      clearDrawn();
      clearHomeReceiverContacts();
      _clickHandler?.destroy?.();
      _clickHandler = null;
      const primitives = (viewer || _viewer)?.scene?.primitives;
      if (_billboards) primitives?.remove(_billboards);
      if (_labels) primitives?.remove(_labels);
      _billboards = null;
      _labels = null;
      _viewer = null;
      _enabled = false;
    },

    /** Brand-coloured legend so the row explains the orange glyphs. */
    getRowControls() {
      return {
        chips: [],
        legend: [
          {
            label: 'Your receiver',
            color: WINGBITS_ORANGE,
            count: _drawn.size,
            blurb:
              'Aircraft heard by your own ADS-B receiver — click one for details',
          },
        ],
      };
    },

    getStats() {
      return { count: _drawn.size, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}

const homeReceiverLayer = createHomeReceiverLayer();

export default homeReceiverLayer;
