import * as Cesium from 'cesium';

/**
 * Power Cuts (NGED) — live outage incidents from National Grid Electricity
 * Distribution, the DNO for the Midlands, South West England and South
 * Wales (fork addition). Polls the server's /api/power-cuts, which reads
 * NGED's open "Live Power Cuts" dataset and nothing else — no key, no
 * client input, a fixed upstream URL.
 *
 * Deliberately simple, mirroring earthquakes.js: static entities rebuilt on
 * each poll, no per-frame animation, no click handler. Nationwide incident
 * counts are small (tens, not thousands), so a full rebuild every poll is
 * cheap.
 */

const API_URL = '/api/power-cuts';

const PLANNED_COLOR = Cesium.Color.fromCssColorString('#3B82F6'); // blue
const ACTIVE_COLOR = Cesium.Color.RED;
const AWAITING_COLOR = Cesium.Color.ORANGE;

/**
 * Colour by what the incident actually means to someone reading the map:
 * planned work reads calm (blue); a live unplanned outage with customers
 * currently off reads urgent (red); an unplanned incident with nobody
 * currently confirmed off (still being assessed, or resolving) reads
 * cautionary (orange).
 * @param {{planned:boolean, confirmedOff:number}} incident
 * @returns {Cesium.Color}
 */
export function powerCutColor(incident) {
  if (incident.planned) return PLANNED_COLOR;
  return incident.confirmedOff > 0 ? ACTIVE_COLOR : AWAITING_COLOR;
}

/**
 * Disc radius (metres) scaled by customers affected, so a city-wide fault
 * reads bigger than a handful-of-postcodes one. Floored so small incidents
 * stay visible and capped so one huge incident doesn't dominate the map.
 * @param {{confirmedOff:number, predictedOff:number}} incident
 * @returns {number}
 */
export function powerCutRadius(incident) {
  const affected = Math.max(incident.confirmedOff, incident.predictedOff, 1);
  return Math.min(15_000, Math.max(600, Math.sqrt(affected) * 250));
}

/**
 * One-line label: region (or category), customer count, and PLANNED when
 * applicable.
 * @param {{region:string|null, category:string|null, confirmedOff:number,
 *   predictedOff:number, planned:boolean}} incident
 * @returns {string}
 */
export function powerCutLabel(incident) {
  const affected = Math.max(incident.confirmedOff, incident.predictedOff);
  const where = incident.region || incident.category || 'Power cut';
  const count = affected > 0 ? ` · ${affected.toLocaleString()} off` : '';
  const planned = incident.planned ? ' · PLANNED' : '';
  return `${where}${count}${planned}`;
}

export function createPowerCutsLayer({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'power-cuts',
    name: 'Power Cuts (NGED)',
    icon: '⚡',
    source: 'National Grid ED',
    updateInterval: 120_000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('power-cuts');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
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
          _lastError = body?.error || `Power cuts feed HTTP ${response.status}`;
          return false;
        }
        if (!Array.isArray(body?.incidents)) {
          _lastError = 'Malformed power cuts response';
          return false;
        }
        if (!_enabled) return true;

        const entities = body.incidents
          .filter(
            (incident) =>
              Number.isFinite(incident.lat) && Number.isFinite(incident.lon),
          )
          .map(
            (incident) =>
              new Cesium.Entity({
                id: `power-cut:${incident.id}`,
                position: Cesium.Cartesian3.fromDegrees(
                  incident.lon,
                  incident.lat,
                ),
                ellipse: {
                  semiMajorAxis: powerCutRadius(incident),
                  semiMinorAxis: powerCutRadius(incident),
                  material: new Cesium.ColorMaterialProperty(
                    powerCutColor(incident).withAlpha(0.35),
                  ),
                  outline: true,
                  outlineColor: powerCutColor(incident).withAlpha(0.9),
                  outlineWidth: 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                },
                label: {
                  text: powerCutLabel(incident),
                  font: '12px "JetBrains Mono", monospace',
                  fillColor: Cesium.Color.WHITE,
                  showBackground: true,
                  backgroundColor: Cesium.Color.BLACK.withAlpha(0.6),
                  backgroundPadding: new Cesium.Cartesian2(6, 3),
                  pixelOffset: new Cesium.Cartesian2(0, -18),
                  verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                  scaleByDistance: new Cesium.NearFarScalar(
                    1.0e4,
                    1.0,
                    3.0e6,
                    0.5,
                  ),
                },
                properties: {
                  incidentId: incident.id,
                  region: incident.region,
                  status: incident.status,
                  planned: incident.planned,
                  category: incident.category,
                  voltage: incident.voltage,
                  confirmedOff: incident.confirmedOff,
                  predictedOff: incident.predictedOff,
                  startTime: incident.startTime,
                  etr: incident.etr,
                  postcodes: incident.postcodes,
                },
              }),
          );

        _dataSource.entities.removeAll();
        for (const entity of entities) _dataSource.entities.add(entity);

        _count = entities.length;
        _lastUpdate = Number.isFinite(body.time)
          ? body.time * 1000
          : Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        console.warn('[Data:PowerCuts] Fetch error:', error);
        _lastError = 'Power cuts network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}

const powerCutsLayer = createPowerCutsLayer();

export default powerCutsLayer;
