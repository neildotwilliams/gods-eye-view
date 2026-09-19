import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _destroyWingbitsContactPanelForTest,
  hideWingbitsContact,
  refreshWingbitsContact,
  showWingbitsContact,
  shownWingbitsContact,
  wingbitsContactFields,
  wingbitsContactPosition,
} from './wingbitsContactPanel.js';

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set();
  }

  reset(value) {
    this.names = new Set(
      String(value || '')
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  add(...names) {
    for (const name of names) this.names.add(name);
  }

  contains(name) {
    return this.names.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.classList = new FakeClassList(this);
    this.textContent = '';
    this.hidden = false;
    this._id = '';
    this._listeners = new Map();
  }

  set id(value) {
    this._id = value;
  }

  get id() {
    return this._id;
  }

  set className(value) {
    this.classList.reset(value);
  }

  setAttribute() {}

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }

  dispatch(type, event = {}) {
    for (const handler of this._listeners.get(type) || []) handler(event);
  }
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function fakeDocument() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  return {
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => findById(head, id) || findById(body, id),
  };
}

function fakeWindow() {
  const listeners = new Map();
  return {
    innerWidth: 1400,
    innerHeight: 900,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
}

/** Install fake browser globals for one test and restore them after. */
function installDom(t) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const doc = fakeDocument();
  const win = fakeWindow();
  globalThis.document = doc;
  globalThis.window = win;
  t.after(() => {
    _destroyWingbitsContactPanelForTest();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { doc, win };
}

const CONTACT = {
  icao24: '4ca123',
  callsign: 'EIN12',
  squawk: '7000',
  onGround: false,
  altitudeM: 3703.32,
  speedMps: 128.6,
  trackDeg: 271.5,
  verticalRateMps: 5.08,
  lat: 51.5,
  lon: -3.2,
};

test('field rows convert to display units and fall back for missing data', () => {
  const fields = Object.fromEntries(wingbitsContactFields(CONTACT));
  assert.equal(fields.ICAO24, '4CA123');
  assert.equal(fields.Callsign, 'EIN12');
  assert.equal(fields.Squawk, '7000');
  assert.equal(fields.Altitude, '12,150 ft');
  assert.equal(fields.Speed, '250 kt');
  assert.equal(fields.Track, '272°');
  assert.equal(fields['Vertical rate'], '+1,000 ft/min');
  assert.equal(fields.Position, '51.5000, -3.2000');

  const sparse = wingbitsContactFields({ icao24: '400abc', onGround: true });
  const sparseFields = Object.fromEntries(sparse);
  assert.equal(sparseFields.Callsign, '—');
  assert.equal(sparseFields.Altitude, 'On ground');
  assert.equal(sparseFields.Speed, '—');
  assert.equal(sparseFields['Vertical rate'], '—');
  assert.equal(sparseFields.Position, '—');
});

test('showWingbitsContact injects styles once and opens with the contact', (t) => {
  const { doc } = installDom(t);
  showWingbitsContact(CONTACT);
  const panel = findById(doc.body, 'gev-wingbits-contact');
  assert.ok(panel, 'panel is appended to the document');
  assert.equal(panel.hidden, false);
  assert.equal(shownWingbitsContact(), '4ca123');
  const styleCount = doc.head.children.filter(
    (el) => el.id === 'gev-wingbits-contact-styles',
  ).length;
  assert.equal(styleCount, 1);

  showWingbitsContact({ ...CONTACT, icao24: '400abc' });
  const stylesAfterSecondShow = doc.head.children.filter(
    (el) => el.id === 'gev-wingbits-contact-styles',
  ).length;
  assert.equal(stylesAfterSecondShow, 1, 'styles are injected only once');
});

test('refresh updates the open contact and ignores a different one', (t) => {
  installDom(t);
  showWingbitsContact(CONTACT);
  refreshWingbitsContact('AABBCC', {
    ...CONTACT,
    icao24: 'aabbcc',
    callsign: 'OTHER',
  });
  assert.equal(
    shownWingbitsContact(),
    '4ca123',
    'a different aircraft does not steal the panel',
  );

  refreshWingbitsContact('4CA123', { ...CONTACT, callsign: 'EIN99' });
  assert.equal(
    shownWingbitsContact(),
    '4ca123',
    'still the same aircraft after a refresh',
  );
});

test('refresh with no contact closes the panel (the aircraft dropped off the feed)', (t) => {
  installDom(t);
  showWingbitsContact(CONTACT);
  refreshWingbitsContact('4ca123', null);
  assert.equal(shownWingbitsContact(), null);
});

test('the close button and Escape both hide the panel', (t) => {
  const { doc, win } = installDom(t);
  showWingbitsContact(CONTACT);
  const closeBtn = doc.body.children
    .find((el) => el.id === 'gev-wingbits-contact')
    .children[0].children.find((el) => el.tagName === 'button');
  closeBtn.dispatch('click');
  assert.equal(shownWingbitsContact(), null);
  assert.equal(findById(doc.body, 'gev-wingbits-contact').hidden, true);

  showWingbitsContact(CONTACT);
  win.dispatch('keydown', { key: 'Escape' });
  assert.equal(shownWingbitsContact(), null);

  // Escape with nothing open must not throw.
  win.dispatch('keydown', { key: 'Escape' });
});

test('hideWingbitsContact is a safe no-op before anything has ever been shown', (t) => {
  installDom(t);
  assert.doesNotThrow(() => hideWingbitsContact());
  assert.equal(shownWingbitsContact(), null);
});

test('position clamps to the viewport and falls back to top-center with no anchor', () => {
  const viewport = { width: 1400, height: 900 };
  const clicked = wingbitsContactPosition({ x: 700, y: 400 }, viewport);
  assert.equal(clicked.left, 700 - 120);
  assert.equal(clicked.top, 416);

  const nearRightEdge = wingbitsContactPosition({ x: 1390, y: 50 }, viewport);
  assert.equal(
    nearRightEdge.left,
    1400 - 240 - 16,
    'clamped off the right edge',
  );

  const nearBottomEdge = wingbitsContactPosition({ x: 700, y: 890 }, viewport);
  assert.equal(
    nearBottomEdge.top,
    900 - 230 - 16,
    'clamped off the bottom edge',
  );

  const nearTopLeft = wingbitsContactPosition({ x: 5, y: 2 }, viewport);
  assert.equal(nearTopLeft.left, 16);
  assert.equal(
    nearTopLeft.top,
    18,
    'top = anchor.y + 16, already clear of the margin',
  );

  const noAnchor = wingbitsContactPosition(null, viewport);
  assert.equal(noAnchor.left, (1400 - 240) / 2);
  assert.equal(noAnchor.top, 92);
});

test('a click positions the panel there; a refresh (no anchor) leaves it in place', (t) => {
  installDom(t);
  showWingbitsContact(CONTACT, { x: 300, y: 200 });
  const panel = () => document.getElementById('gev-wingbits-contact');
  const firstLeft = panel().style.left;
  assert.equal(firstLeft, '180px');
  assert.equal(panel().style.top, '216px');

  refreshWingbitsContact('4ca123', { ...CONTACT, callsign: 'EIN99' });
  assert.equal(
    panel().style.left,
    firstLeft,
    'a refresh does not move the panel',
  );

  showWingbitsContact({ ...CONTACT, icao24: 'bbbbbb' }, { x: 900, y: 700 });
  assert.notEqual(
    panel().style.left,
    firstLeft,
    'a fresh click repositions it',
  );
});
