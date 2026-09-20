import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createPowerCutsLayer,
  powerCutColor,
  powerCutLabel,
  powerCutRadius,
} from './powerCuts.js';

function fakeViewer() {
  const sources = new Set();
  return {
    dataSources: {
      add: (ds) => {
        sources.add(ds);
        return ds;
      },
      remove: (ds) => {
        sources.delete(ds);
      },
    },
    _sources: sources,
  };
}

function controllableFetch() {
  let response = {
    ok: true,
    status: 200,
    json: async () => ({ time: 0, incidents: [] }),
  };
  const impl = async () => response;
  impl.set = (body, ok = true, status = ok ? 200 : 500) => {
    response = { ok, status, json: async () => body };
  };
  return impl;
}

const PLANNED = {
  id: 'INCD-1',
  planned: true,
  confirmedOff: 0,
  predictedOff: 50,
  region: 'South Wales',
  category: 'HV',
  lat: 51.6,
  lon: -3.9,
};
const ACTIVE = {
  id: 'INCD-2',
  planned: false,
  confirmedOff: 30,
  predictedOff: 30,
  region: 'South Wales',
  category: 'LV',
  lat: 51.5,
  lon: -3.2,
};
const AWAITING = {
  id: 'INCD-3',
  planned: false,
  confirmedOff: 0,
  predictedOff: 10,
  region: 'South West',
  category: 'LV',
  lat: 50.9,
  lon: -3.5,
};

test('colour follows the planned/active/awaiting distinction', () => {
  assert.equal(
    powerCutColor(PLANNED).toCssHexString(),
    '#3B82F6'.toLowerCase(),
  );
  assert.ok(powerCutColor(ACTIVE).equals(Cesium.Color.RED));
  assert.ok(powerCutColor(AWAITING).equals(Cesium.Color.ORANGE));
  assert.ok(!powerCutColor(ACTIVE).equals(powerCutColor(AWAITING)));
});

test('radius grows with customers affected and stays within bounds', () => {
  const small = powerCutRadius({ confirmedOff: 1, predictedOff: 0 });
  const big = powerCutRadius({ confirmedOff: 5000, predictedOff: 5000 });
  assert.ok(small >= 600, 'never smaller than the floor');
  assert.ok(big <= 15_000, 'never bigger than the cap');
  assert.ok(big > small, 'more customers reads bigger');
});

test('label reports where, how many, and PLANNED when applicable', () => {
  assert.equal(powerCutLabel(ACTIVE), 'South Wales · 30 off');
  assert.equal(powerCutLabel(PLANNED), 'South Wales · 50 off · PLANNED');
  assert.equal(
    powerCutLabel({
      region: null,
      category: null,
      confirmedOff: 0,
      predictedOff: 0,
      planned: false,
    }),
    'Power cut',
  );
});

test('draws one entity per positioned incident and reports stats', async () => {
  const fetchImpl = controllableFetch();
  const layer = createPowerCutsLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  try {
    fetchImpl.set({ time: 1000, incidents: [PLANNED, ACTIVE, AWAITING] });
    assert.equal(await layer.update(), true);
    assert.equal(layer.getStats().count, 3);
    assert.equal(layer.getStats().lastUpdate, 1_000_000);
    assert.equal(layer.getStats().error, null);
  } finally {
    layer.destroy(viewer);
  }
});

test('a later poll fully replaces the previous incidents', async () => {
  const fetchImpl = controllableFetch();
  const layer = createPowerCutsLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  try {
    fetchImpl.set({ time: 1, incidents: [PLANNED, ACTIVE] });
    await layer.update();
    assert.equal(layer.getStats().count, 2);

    fetchImpl.set({ time: 2, incidents: [AWAITING] });
    await layer.update();
    assert.equal(layer.getStats().count, 1, 'the resolved incidents are gone');
  } finally {
    layer.destroy(viewer);
  }
});

test('incidents without a usable position are skipped', async () => {
  const fetchImpl = controllableFetch();
  const layer = createPowerCutsLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  try {
    fetchImpl.set({ time: 1, incidents: [ACTIVE, { ...AWAITING, lat: null }] });
    await layer.update();
    assert.equal(layer.getStats().count, 1);
  } finally {
    layer.destroy(viewer);
  }
});

test('an error response is reported without discarding what is already drawn', async () => {
  const fetchImpl = controllableFetch();
  const layer = createPowerCutsLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  try {
    fetchImpl.set({ time: 1, incidents: [ACTIVE] });
    await layer.update();

    fetchImpl.set(
      { error: 'National Grid power cuts feed unreachable' },
      false,
      502,
    );
    assert.equal(await layer.update(), false);
    assert.equal(
      layer.getStats().error,
      'National Grid power cuts feed unreachable',
    );
    assert.equal(
      layer.getStats().count,
      1,
      'stale incidents stay visible rather than vanishing',
    );
  } finally {
    layer.destroy(viewer);
  }
});

test('disable hides the data source without clearing it, so a re-enable is instant', async () => {
  const fetchImpl = controllableFetch();
  fetchImpl.set({ time: 1, incidents: [ACTIVE] });
  const layer = createPowerCutsLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  layer.disable();
  assert.equal(
    layer.getStats().count,
    1,
    'entities are retained while disabled',
  );
  layer.destroy(viewer);
});

test('destroy removes the data source from the viewer', async () => {
  const fetchImpl = controllableFetch();
  const layer = createPowerCutsLayer({ fetchImpl });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(viewer._sources.size, 1);
  layer.destroy(viewer);
  assert.equal(viewer._sources.size, 0);
});
