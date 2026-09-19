import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createHomeReceiverLayer } from './homeReceiverLayer.js';
import { homeReceiverOwns } from './homeReceiver.js';
import { CLASS_SCALE_2D } from './aircraftClass.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../renderGovernor.js';

/** A fake ScreenSpaceEventHandler that lets a test fire a registered event directly. */
function fakeHandler() {
  const actions = new Map();
  return {
    setInputAction(fn, type) {
      actions.set(type, fn);
    },
    fire(type, event) {
      actions.get(type)?.(event);
    },
    destroy() {},
  };
}

/**
 * A fake Billboard/LabelCollection. Real `Cesium.LabelCollection` needs a
 * DOM `document` (for canvas font-metrics) even just to `.add()` headlessly,
 * which this test environment has no polyfill for — so both collections are
 * injected as this minimal stand-in instead.
 */
function fakeCollection() {
  const items = new Set();
  return {
    show: false,
    add(options) {
      const item = { ...options };
      items.add(item);
      return item;
    },
    remove(item) {
      items.delete(item);
    },
    removeAll() {
      items.clear();
    },
    get size() {
      return items.size;
    },
  };
}

function fakeViewer() {
  const primitives = new Set();
  return {
    scene: {
      canvas: {},
      primitives: {
        add: (p) => {
          primitives.add(p);
          return p;
        },
        remove: (p) => {
          primitives.delete(p);
        },
      },
      pick: () => null,
    },
    _primitives: primitives,
  };
}

/** Every test injects the same DOM-free collections/handler by default. */
function makeLayer(overrides = {}) {
  return createHomeReceiverLayer({
    screenSpaceEventHandlerFactory: () => fakeHandler(),
    createBillboardCollection: fakeCollection,
    createLabelCollection: fakeCollection,
    ...overrides,
  });
}

/** A fetch stub whose response can be changed between polls with `.set(...)`. */
function controllableFetch() {
  let response = {
    ok: true,
    status: 200,
    json: async () => ({ time: 0, aircraft: [] }),
  };
  const impl = async () => response;
  impl.set = (body, ok = true, status = ok ? 200 : 500) => {
    response = { ok, status, json: async () => body };
  };
  return impl;
}

function governorReasons() {
  return getRenderGovernorDiagnostics().recentRequests.map(
    (entry) => entry.reason,
  );
}

const CONTACT_A = {
  icao24: 'aaa111',
  callsign: 'ABC1',
  squawk: '2000',
  lat: 51.5,
  lon: -3.2,
  altitudeM: 1000,
  speedMps: 100,
  trackDeg: 90,
  verticalRateMps: 0,
  onGround: false,
};
const CONTACT_B = {
  icao24: 'bbb222',
  callsign: 'DEF2',
  squawk: null,
  lat: 52.0,
  lon: -3.0,
  altitudeM: 0,
  speedMps: null,
  trackDeg: null,
  verticalRateMps: null,
  onGround: true,
};

test('draws contacts, updates one in place, and removes one that drops off the feed', async () => {
  const fetchImpl = controllableFetch();
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  try {
    fetchImpl.set({ time: 1000, aircraft: [CONTACT_A, CONTACT_B] });
    assert.equal(await layer.update(), true);
    assert.equal(layer.getStats().count, 2);
    assert.equal(layer.getStats().lastUpdate, 1_000_000);
    assert.equal(homeReceiverOwns('aaa111'), true);
    assert.equal(homeReceiverOwns('bbb222'), true);
    assert.equal(layer.getRowControls().legend[0].count, 2);

    fetchImpl.set({ time: 1003, aircraft: [{ ...CONTACT_A, lat: 51.6 }] });
    assert.equal(await layer.update(), true);
    assert.equal(layer.getStats().count, 1, 'B dropped off the feed');
    assert.equal(homeReceiverOwns('bbb222'), false, 'B is released');
    assert.equal(
      homeReceiverOwns('aaa111'),
      true,
      'A is still owned, updated in place',
    );
  } finally {
    layer.destroy(viewer);
  }
});

/** A fakeCollection whose added items stay reachable by id, for size assertions. */
function trackedCollection() {
  const byId = new Map();
  const collection = {
    show: false,
    add(options) {
      const item = { ...options };
      byId.set(item.id, item);
      return item;
    },
    remove(item) {
      byId.delete(item.id);
    },
    removeAll() {
      byId.clear();
    },
  };
  return { collection, byId };
}

test('billboard size follows aircraft class, on both first draw and later updates', async () => {
  const fetchImpl = controllableFetch();
  const { collection: billboards, byId } = trackedCollection();
  const layer = makeLayer({
    fetchImpl,
    createBillboardCollection: () => billboards,
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  try {
    // category 6 = widebody (CLASS_SCALE_2D 1.3), category 2 = light (0.62).
    fetchImpl.set({
      time: 1,
      aircraft: [
        { ...CONTACT_A, category: 6 },
        { ...CONTACT_B, category: 2, onGround: false },
      ],
    });
    await layer.update();
    assert.equal(byId.get('aaa111').width, 22 * CLASS_SCALE_2D.widebody);
    assert.equal(byId.get('bbb222').width, 22 * CLASS_SCALE_2D.light);
    assert.notEqual(
      byId.get('aaa111').width,
      byId.get('bbb222').width,
      'a widebody and a light aircraft read as different sizes',
    );

    // Same aircraft, reclassified on a later poll — the update-in-place path
    // must also recompute the size, not just at first draw.
    fetchImpl.set({ time: 2, aircraft: [{ ...CONTACT_A, category: 8 }] });
    await layer.update();
    assert.equal(byId.get('aaa111').width, 22 * CLASS_SCALE_2D.helicopter);
  } finally {
    layer.destroy(viewer);
  }
});

test('disable clears drawn contacts and releases pick ownership', async () => {
  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A] });
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().count, 1);
  layer.disable();
  assert.equal(layer.getStats().count, 0);
  assert.equal(homeReceiverOwns('aaa111'), false);
  layer.destroy(viewer);
});

test('an error response is reported without discarding what is already drawn', async () => {
  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A] });
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  fetchImpl.set({ error: 'No home receiver configured' }, false, 503);
  assert.equal(await layer.update(), false);
  assert.equal(layer.getStats().error, 'No home receiver configured');
  assert.equal(
    layer.getStats().count,
    1,
    'stale contacts stay visible rather than vanishing',
  );
  layer.destroy(viewer);
});

test('clicking a drawn contact opens its details; other picks are ignored', async () => {
  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A] });
  let picked = null;
  const shown = [];
  const handler = fakeHandler();
  const viewer = fakeViewer();
  viewer.scene.pick = () => picked;
  const layer = makeLayer({
    fetchImpl,
    screenSpaceEventHandlerFactory: () => handler,
    showContact: (contact) => shown.push(contact),
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  try {
    handler.fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, {
      position: { x: 1, y: 1 },
    });
    assert.equal(shown.length, 0, 'empty space opens nothing');

    picked = { id: 'zzz999' };
    handler.fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, {
      position: { x: 1, y: 1 },
    });
    assert.equal(
      shown.length,
      0,
      'a pick belonging to another layer opens nothing',
    );

    picked = { id: 'aaa111' };
    handler.fire(Cesium.ScreenSpaceEventType.LEFT_CLICK, {
      position: { x: 1, y: 1 },
    });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].icao24, 'aaa111');
  } finally {
    layer.destroy(viewer);
  }
});

test('an open details box stays live across polls and closes if the aircraft drops off', async () => {
  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A, CONTACT_B] });
  const refreshCalls = [];
  const layer = makeLayer({
    fetchImpl,
    shownContact: () => 'aaa111',
    refreshContact: (id, contact) => refreshCalls.push([id, contact]),
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0][0], 'aaa111');
  assert.equal(
    refreshCalls[0][1].icao24,
    'aaa111',
    'refreshed with the fresh contact',
  );

  fetchImpl.set({ time: 2, aircraft: [CONTACT_B] }); // A drops off the feed
  await layer.update();
  assert.equal(refreshCalls.length, 2);
  assert.equal(refreshCalls[1][1], null, 'told the panel its aircraft is gone');
  layer.destroy(viewer);
});

test('destroy removes both primitive collections and stops ownership', async () => {
  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A] });
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(
    viewer._primitives.size,
    2,
    'billboard + label collections registered',
  );
  layer.destroy(viewer);
  assert.equal(viewer._primitives.size, 0);
  assert.equal(homeReceiverOwns('aaa111'), false);
});

test('interpolates a moving contact once a second and never holds continuous rendering', async (t) => {
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => _resetRenderGovernorForTest());

  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A] }); // 100 m/s track 90 — keeps moving
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  assert.deepEqual(
    governorReasons(),
    [],
    'no render requested until the first tick',
  );
  t.mock.timers.tick(1000);
  assert.deepEqual(governorReasons(), ['layer-tick:home-receiver']);
  t.mock.timers.tick(1000);
  assert.deepEqual(governorReasons(), [
    'layer-tick:home-receiver',
    'layer-tick:home-receiver',
  ]);
  assert.equal(
    getRenderGovernorDiagnostics().mode,
    'idle',
    'a single request per tick, not a continuous hold',
  );

  layer.destroy(viewer);
});

test('a contact with no usable speed/track is never nudged, so no render is requested', async (t) => {
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => _resetRenderGovernorForTest());

  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_B] });
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();

  t.mock.timers.tick(3000);
  assert.deepEqual(governorReasons(), []);
  layer.destroy(viewer);
});

test('the interpolation timer stops on disable and does not restart itself', async (t) => {
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.after(() => _resetRenderGovernorForTest());

  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, aircraft: [CONTACT_A] });
  const layer = makeLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.disable();

  t.mock.timers.tick(5000);
  assert.deepEqual(governorReasons(), [], 'no ticking while disabled');
  layer.destroy(viewer);
});
