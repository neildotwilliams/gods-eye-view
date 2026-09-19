/**
 * Wingbits contact details panel (fork addition).
 *
 * A small self-contained box that opens when the operator clicks an aircraft
 * on the Wingbits (Home) layer — the same idea as the CCTV viewer box, but
 * for one aircraft's raw receiver data instead of a camera frame. It injects
 * its own markup and styles on first use (mirrors the pattern in
 * `src/annotations/screenAnnotationRenderer.js`) so it carries no dependency
 * on index.html or the panel-stack layout system, and stays usable from a
 * plain layer click handler.
 */

const METRES_TO_FEET = 1 / 0.3048;
const MPS_TO_KNOTS = 1.943844;

/** Panel footprint used to clamp it on-screen; content is fixed-shape, so a constant is safe. */
const PANEL_WIDTH = 240;
const PANEL_HEIGHT_ESTIMATE = 230;
const PANEL_MARGIN = 16;

let _root = null;
let _title = null;
let _body = null;
let _closeBtn = null;
let _shownIcao24 = null;
let _keydownHandler = null;
let _positioned = false;

function injectStyles() {
  if (document.getElementById('gev-wingbits-contact-styles')) return;
  const style = document.createElement('style');
  style.id = 'gev-wingbits-contact-styles';
  style.textContent = `
  .gev-wingbits-contact {
    position: fixed;
    width: 240px;
    z-index: 70;
    background: rgba(12, 12, 20, 0.82);
    border: 1px solid rgba(255, 113, 33, 0.35);
    border-radius: 12px;
    backdrop-filter: blur(14px);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45), 0 0 24px rgba(255, 113, 33, 0.1);
    padding: 10px 12px 12px;
    font: 11px/1.4 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace;
    color: #e8eaed;
  }
  .gev-wingbits-contact[hidden] { display: none; }
  .gev-wingbits-contact-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 113, 33, 0.2);
  }
  .gev-wingbits-contact-icon { font-size: 13px; line-height: 1; }
  .gev-wingbits-contact-title {
    flex: 1;
    min-width: 0;
    color: #FF7121;
    font-weight: 700;
    letter-spacing: 0.04em;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gev-wingbits-contact-close {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(232, 234, 237, 0.6);
    width: 20px;
    height: 20px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    flex: none;
  }
  .gev-wingbits-contact-close:hover,
  .gev-wingbits-contact-close:focus-visible {
    color: #FF7121;
    border-color: rgba(255, 113, 33, 0.45);
    outline: none;
  }
  .gev-wingbits-contact-body {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 5px 10px;
    margin: 0;
  }
  .gev-wingbits-contact-body dt { color: rgba(232, 234, 237, 0.5); }
  .gev-wingbits-contact-body dd {
    margin: 0;
    color: #e8eaed;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .gev-wingbits-contact-stale {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 184, 0, 0.85);
    font-size: 10px;
  }
  `;
  document.head.appendChild(style);
}

function ensurePanel() {
  if (_root) return;
  injectStyles();
  _root = document.createElement('div');
  _root.id = 'gev-wingbits-contact';
  _root.className = 'gev-wingbits-contact';
  _root.hidden = true;
  _root.setAttribute('role', 'dialog');
  _root.setAttribute('aria-label', 'Aircraft details');

  const header = document.createElement('div');
  header.className = 'gev-wingbits-contact-header';
  const icon = document.createElement('span');
  icon.className = 'gev-wingbits-contact-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '📡';
  _title = document.createElement('span');
  _title.className = 'gev-wingbits-contact-title';
  _closeBtn = document.createElement('button');
  _closeBtn.type = 'button';
  _closeBtn.className = 'gev-wingbits-contact-close';
  _closeBtn.setAttribute('aria-label', 'Close aircraft details');
  _closeBtn.title = 'Close';
  _closeBtn.textContent = '×';
  _closeBtn.addEventListener('click', hideWingbitsContact);
  header.append(icon, _title, _closeBtn);

  _body = document.createElement('dl');
  _body.className = 'gev-wingbits-contact-body';

  _root.append(header, _body);
  document.body.appendChild(_root);

  _keydownHandler = (event) => {
    if (event.key === 'Escape' && _shownIcao24) hideWingbitsContact();
  };
  window.addEventListener('keydown', _keydownHandler);
}

/**
 * Where to place the panel: anchored just below-and-centered on the click
 * that opened it, clamped so it always stays fully on screen. Pure, so it
 * is testable without a DOM. A null anchor (no click position known) falls
 * back to a fixed top-center spot, clear of the app's own corner chrome.
 * @param {{x:number,y:number}|null} anchor Click position in viewport px.
 * @param {{width:number,height:number}} viewport
 * @returns {{left:number, top:number}}
 */
export function wingbitsContactPosition(anchor, viewport) {
  const width = Number.isFinite(viewport?.width) ? viewport.width : 1280;
  const height = Number.isFinite(viewport?.height) ? viewport.height : 800;
  const clampAxis = (value, max) =>
    Math.min(Math.max(value, PANEL_MARGIN), Math.max(PANEL_MARGIN, max));
  if (!anchor) {
    return {
      left: clampAxis(
        (width - PANEL_WIDTH) / 2,
        width - PANEL_WIDTH - PANEL_MARGIN,
      ),
      top: PANEL_MARGIN + 76,
    };
  }
  return {
    left: clampAxis(
      anchor.x - PANEL_WIDTH / 2,
      width - PANEL_WIDTH - PANEL_MARGIN,
    ),
    top: clampAxis(
      anchor.y + 16,
      height - PANEL_HEIGHT_ESTIMATE - PANEL_MARGIN,
    ),
  };
}

function row(label, value) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  return [dt, dd];
}

/**
 * Build the display fields for a receiver contact. Pure, so it is testable
 * without a DOM.
 * @param {object} contact One row from GET /api/home-receiver (SI units).
 * @returns {Array<[string, string]>} Ordered [label, value] pairs.
 */
export function wingbitsContactFields(contact) {
  const fields = [];
  fields.push(['ICAO24', String(contact.icao24 || '—').toUpperCase()]);
  fields.push(['Callsign', contact.callsign || '—']);
  fields.push(['Squawk', contact.squawk || '—']);
  fields.push([
    'Altitude',
    contact.onGround
      ? 'On ground'
      : Number.isFinite(contact.altitudeM)
        ? `${Math.round(contact.altitudeM * METRES_TO_FEET).toLocaleString()} ft`
        : '—',
  ]);
  fields.push([
    'Speed',
    Number.isFinite(contact.speedMps)
      ? `${Math.round(contact.speedMps * MPS_TO_KNOTS)} kt`
      : '—',
  ]);
  fields.push([
    'Track',
    Number.isFinite(contact.trackDeg)
      ? `${Math.round(contact.trackDeg)}°`
      : '—',
  ]);
  fields.push([
    'Vertical rate',
    Number.isFinite(contact.verticalRateMps)
      ? `${contact.verticalRateMps >= 0 ? '+' : ''}${Math.round(contact.verticalRateMps * METRES_TO_FEET * 60).toLocaleString()} ft/min`
      : '—',
  ]);
  fields.push([
    'Position',
    Number.isFinite(contact.lat) && Number.isFinite(contact.lon)
      ? `${contact.lat.toFixed(4)}, ${contact.lon.toFixed(4)}`
      : '—',
  ]);
  return fields;
}

/**
 * Open (or refresh, if already open on the same aircraft) the contact panel.
 * @param {object} contact One row from GET /api/home-receiver.
 * @param {{x:number,y:number}|null} [anchor] Click position in viewport px;
 *   omit to update content in place without moving an already-open panel.
 */
export function showWingbitsContact(contact, anchor = null) {
  if (!contact?.icao24) return;
  ensurePanel();
  _shownIcao24 = String(contact.icao24).toLowerCase();
  _title.textContent = contact.callsign || String(contact.icao24).toUpperCase();
  _body.replaceChildren();
  for (const [label, value] of wingbitsContactFields(contact)) {
    const [dt, dd] = row(label, value);
    _body.append(dt, dd);
  }
  // Reposition on a genuine click (an anchor) or the very first open ever;
  // a poll refresh of an already-open panel (no anchor) leaves it in place.
  if (anchor || !_positioned) {
    const { left, top } = wingbitsContactPosition(anchor, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    _root.style.left = `${left}px`;
    _root.style.top = `${top}px`;
    _positioned = true;
  }
  _root.hidden = false;
}

/**
 * Refresh the panel's fields only if it is currently showing this aircraft.
 * Callers pass every poll's contact list; a no-op when nothing matches or
 * the panel is closed, so this is safe to call unconditionally.
 * @param {string} icao24
 * @param {object|null} contact Fresh contact, or null if it dropped off the feed.
 */
export function refreshWingbitsContact(icao24, contact) {
  if (!_shownIcao24 || String(icao24).toLowerCase() !== _shownIcao24) return;
  if (!contact) {
    hideWingbitsContact();
    return;
  }
  showWingbitsContact(contact);
}

/** Close the panel, if open. */
export function hideWingbitsContact() {
  _shownIcao24 = null;
  if (_root) _root.hidden = true;
}

/** @returns {string|null} The lower-cased icao24 currently shown, or null. */
export function shownWingbitsContact() {
  return _shownIcao24;
}

/** Test/teardown seam: remove the injected DOM and listeners entirely. */
export function _destroyWingbitsContactPanelForTest() {
  if (_keydownHandler) window.removeEventListener('keydown', _keydownHandler);
  _root?.remove();
  document.getElementById('gev-wingbits-contact-styles')?.remove();
  _root = null;
  _title = null;
  _body = null;
  _closeBtn = null;
  _shownIcao24 = null;
  _keydownHandler = null;
  _positioned = false;
}
