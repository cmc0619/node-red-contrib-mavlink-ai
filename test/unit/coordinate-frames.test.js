'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  metersToLatLonDelta,
  offsetLatLon,
  nedOffsetToGlobal,
  globalToNedOffset,
  degToDegE7,
  degE7ToDeg
} = require('../../lib/swarm/coordinate-frames');

test('meters north maps to latitude delta independent of longitude (#46)', () => {
  const { dLat, dLon } = metersToLatLonDelta(111, 0, 39);
  // ~111m north is ~0.001 degrees of latitude anywhere on earth.
  assert.ok(Math.abs(dLat - 0.000997) < 0.0001, `dLat ${dLat}`);
  assert.strictEqual(dLon, 0);
});

test('meters east scales with cos(latitude) (#46)', () => {
  const equator = metersToLatLonDelta(0, 100, 0);
  const mid = metersToLatLonDelta(0, 100, 60);
  // At 60N a meter east covers twice the longitude degrees it does at the equator.
  assert.ok(Math.abs(mid.dLon / equator.dLon - 2) < 0.01);
});

test('offsetLatLon round-trips through globalToNedOffset (#46)', () => {
  const origin = { lat: 39.1, lon: -75.1, alt: 40 };
  const target = nedOffsetToGlobal(origin, { north: 25, east: -10, up: 5 });
  assert.ok(target.lat > origin.lat);
  assert.ok(target.lon < origin.lon);
  assert.strictEqual(target.alt, 45); // up 5 means altitude increases
  const back = globalToNedOffset(origin, target);
  assert.ok(Math.abs(back.north - 25) < 0.01, `north ${back.north}`);
  assert.ok(Math.abs(back.east - -10) < 0.01, `east ${back.east}`);
  assert.ok(Math.abs(back.down - -5) < 0.01, `down ${back.down}`);
});

test('NED down is altitude-negative (#46)', () => {
  const target = nedOffsetToGlobal({ lat: 0, lon: 0, alt: 100 }, { down: 30 });
  assert.strictEqual(target.alt, 70);
});

test('setting both down and up is rejected (#46)', () => {
  assert.throws(
    () => nedOffsetToGlobal({ lat: 0, lon: 0 }, { down: 1, up: 1 }),
    (err) => err.code === 'BAD_COORDINATES'
  );
});

test('non-finite input yields BAD_COORDINATES naming the field (#46)', () => {
  assert.throws(
    () => offsetLatLon({ lat: 'nope', lon: 0 }, { north: 1 }),
    (err) => err.code === 'BAD_COORDINATES' && /origin\.lat/.test(err.message)
  );
});

test('polar latitudes are rejected instead of dividing by ~zero (#46)', () => {
  assert.throws(
    () => metersToLatLonDelta(0, 10, 90),
    (err) => err.code === 'BAD_COORDINATES'
  );
});

test('degE7 wire scaling round-trips (#46)', () => {
  assert.strictEqual(degToDegE7(47.397742), 473977420);
  assert.strictEqual(degE7ToDeg(473977420), 47.397742);
});
