import test from 'node:test';
import assert from 'node:assert/strict';
import { CLASS_SCALE_2D } from './aircraftClass.js';
import {
  HOME_RECEIVER_MAX_EXTRAPOLATION_S,
  WINGBITS_CHARCOAL,
  WINGBITS_ORANGE,
  clearHomeReceiverContacts,
  homeReceiverContactLabel,
  homeReceiverDeadReckon,
  homeReceiverIconKind,
  homeReceiverIconScale,
  homeReceiverOwns,
  setHomeReceiverContacts,
} from './homeReceiver.js';

test('uses the Wingbits brand colours', () => {
  assert.equal(WINGBITS_ORANGE, '#FF7121');
  assert.equal(WINGBITS_CHARCOAL, '#1E1B1B');
});

test('labels show callsign (or hex) and flight level, or GND on the ground', () => {
  assert.equal(
    homeReceiverContactLabel({
      icao24: '4ca123',
      callsign: 'EIN12',
      altitudeM: 3703.3,
      onGround: false,
    }),
    'EIN12 · FL121',
  );
  assert.equal(
    homeReceiverContactLabel({
      icao24: '400abc',
      callsign: null,
      altitudeM: 0,
      onGround: true,
    }),
    '400ABC · GND',
  );
  assert.equal(
    homeReceiverContactLabel({
      icao24: '406def',
      callsign: 'G-ABCD',
      altitudeM: null,
      onGround: false,
    }),
    'G-ABCD',
  );
  assert.equal(
    homeReceiverContactLabel({
      icao24: '406def',
      callsign: 'LOW1',
      altitudeM: 150,
      onGround: false,
    }),
    'LOW1 · FL005',
  );
});

test('icon kind follows the emitter category', () => {
  assert.equal(homeReceiverIconKind({ category: 8 }), 'helicopter');
  assert.equal(homeReceiverIconKind({ category: null }), 'airliner');
});

test('icon scale follows the shared per-class table, used by Live Flights too', () => {
  assert.equal(homeReceiverIconScale({ category: 6 }), CLASS_SCALE_2D.widebody);
  assert.equal(
    homeReceiverIconScale({ category: 8 }),
    CLASS_SCALE_2D.helicopter,
  );
  assert.equal(homeReceiverIconScale({ category: 7 }), CLASS_SCALE_2D.fastjet);
  assert.equal(
    homeReceiverIconScale({ category: null }),
    CLASS_SCALE_2D.airliner,
  );
  assert.notEqual(
    CLASS_SCALE_2D.widebody,
    CLASS_SCALE_2D.light,
    'sanity: classes really do differ',
  );
});

test('the owned-contact registry lets Live Flights hide duplicates only while active', () => {
  clearHomeReceiverContacts();
  assert.equal(homeReceiverOwns('4ca123'), false);
  setHomeReceiverContacts(['4CA123', '400abc']);
  assert.equal(homeReceiverOwns('4ca123'), true, 'case-insensitive');
  assert.equal(homeReceiverOwns('abcdef'), false);
  clearHomeReceiverContacts();
  assert.equal(
    homeReceiverOwns('4ca123'),
    false,
    'disabling the layer releases every contact',
  );
});

test('dead reckoning advances along track, climbs, and stops after the cap', () => {
  const contact = {
    lat: 51.5,
    lon: -3.2,
    altitudeM: 10000,
    speedMps: 200,
    trackDeg: 90,
    verticalRateMps: 5,
    onGround: false,
  };
  const moved = homeReceiverDeadReckon(contact, 10);
  assert.ok(Math.abs(moved.lat - 51.5) < 1e-6, 'due east keeps latitude');
  const metresEast =
    (moved.lon - -3.2) *
    (Math.PI / 180) *
    6_371_000 *
    Math.cos((51.5 * Math.PI) / 180);
  assert.ok(
    Math.abs(metresEast - 2000) < 1,
    `moved ${metresEast} m, want 2000`,
  );
  assert.equal(moved.altitudeM, 10050);

  const north = homeReceiverDeadReckon({ ...contact, trackDeg: 0 }, 10);
  assert.ok(north.lat > 51.5 && Math.abs(north.lon - -3.2) < 1e-9);

  const capped = homeReceiverDeadReckon(contact, 60);
  const atCap = homeReceiverDeadReckon(
    contact,
    HOME_RECEIVER_MAX_EXTRAPOLATION_S,
  );
  assert.deepEqual(capped, atCap, 'never extrapolates past the cap');
});

test('dead reckoning leaves contacts without motion data in place', () => {
  const still = {
    lat: 51.5,
    lon: -3.2,
    altitudeM: 0,
    speedMps: null,
    trackDeg: 90,
  };
  assert.deepEqual(homeReceiverDeadReckon(still, 5), {
    lat: 51.5,
    lon: -3.2,
    altitudeM: 0,
  });
  const grounded = homeReceiverDeadReckon(
    {
      lat: 51.5,
      lon: -3.2,
      altitudeM: 0,
      speedMps: 8,
      trackDeg: 0,
      verticalRateMps: -3,
      onGround: true,
    },
    5,
  );
  assert.ok(grounded.lat > 51.5, 'taxiing aircraft still move');
  assert.equal(grounded.altitudeM, 0, 'grounded aircraft stay on the ground');
  assert.deepEqual(homeReceiverDeadReckon(still, -4), {
    lat: 51.5,
    lon: -3.2,
    altitudeM: 0,
  });
});
