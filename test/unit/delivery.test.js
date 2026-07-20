'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DELIVERY, resolveDeliveryMode } = require('../../lib/util/delivery');

test('resolveDeliveryMode returns an allowed mode', () => {
  assert.strictEqual(resolveDeliveryMode({ delivery: 'build' }, { allow: ['build', 'send', 'await'] }), 'build');
  assert.strictEqual(resolveDeliveryMode({ delivery: 'await' }, { allow: ['build', 'send', 'await'] }), 'await');
});

test('resolveDeliveryMode throws DELIVERY_UNSET for a missing mode (no migration)', () => {
  assert.throws(() => resolveDeliveryMode({}, { allow: ['build', 'send'] }), (e) => e.code === 'DELIVERY_UNSET');
  assert.throws(() => resolveDeliveryMode({ delivery: '' }, { allow: ['build', 'send'] }), (e) => e.code === 'DELIVERY_UNSET');
});

test('resolveDeliveryMode throws DELIVERY_UNSET for a mode this node does not support', () => {
  assert.throws(() => resolveDeliveryMode({ delivery: 'stream' }, { allow: ['build', 'send', 'await'] }), (e) => e.code === 'DELIVERY_UNSET');
  assert.throws(() => resolveDeliveryMode({ delivery: 'bogus' }, { allow: ['build'] }), (e) => e.code === 'DELIVERY_UNSET');
});

test('DELIVERY exposes the four mode constants', () => {
  assert.deepStrictEqual(DELIVERY, { BUILD: 'build', SEND: 'send', AWAIT: 'await', STREAM: 'stream' });
});
