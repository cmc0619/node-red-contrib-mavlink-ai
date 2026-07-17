'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  metersToLatLonDelta,
  offsetLatLon,
  nedOffsetToGlobal,
  globalToNedOffset
} = require('../../lib/swarm/coordinate-frames');
const { degToDegE7, degE7ToDeg } = require('../../lib/util/geo');

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

test('null/empty origins are rejected, not treated as lat/lon 0 (#46)', () => {
  // Number(null) === 0, so a naive coercion would silently aim at "null
  // island" — a missing origin must throw instead.
  const isBad = (err) => err.code === 'BAD_COORDINATES';
  assert.throws(() => offsetLatLon(null, { north: 10 }), isBad);
  assert.throws(() => nedOffsetToGlobal(null, { north: 10 }), isBad);
  assert.throws(() => globalToNedOffset(null, { lat: 1, lon: 1 }), isBad);
  assert.throws(() => globalToNedOffset({ lat: 1, lon: 1 }, null), isBad);
  assert.throws(() => offsetLatLon({ lat: null, lon: 0 }, {}), isBad);
  assert.throws(() => offsetLatLon({ lat: '', lon: 0 }, {}), isBad);
  assert.throws(() => offsetLatLon({ lat: true, lon: 0 }, {}), isBad);
  // Numeric strings keep working (JSON payloads often carry them).
  const ok = offsetLatLon({ lat: '39.1', lon: '-75.1' }, { north: 0 });
  assert.strictEqual(ok.lat, 39.1);
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
