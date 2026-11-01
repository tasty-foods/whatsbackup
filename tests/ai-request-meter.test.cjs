'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequestMeter } = require('../src/ai/request-meter');

function fixture() {
  let clock = new Date(2026, 9, 31, 23, 59, 59).getTime();
  const rows = [], store = {
    startRun(kind, model, provider) { rows.push({ id: rows.length + 1, kind, model, provider, started_at: clock }); return rows.length; },
    updateRun(id, patch) { Object.assign(rows.find(row => row.id === id), patch); },
  };
  const meter = createRequestMeter({ store, kind: 'search', provider: 'openai', model: 'fixture-model', now: () => clock });
  return { meter, rows, store, setTime: next => { clock = next; } };
}
const receipt = (cost = 0.001, costCap = cost) => ({ usage: { in: 120, out: 50, reasoning: 20 }, cost, costCap });

test('standalone search records receipts incrementally and finishes exactly one ledger row', () => {
  const h = fixture(); assert.equal(h.rows.length, 0);
  h.meter.onUsage(receipt());
  assert.equal(h.rows.length, 1); assert.equal(h.rows[0].tokens_in, 120); assert.equal(h.rows[0].tokens_out, 50);
  assert.equal(h.rows[0].finished_at, undefined);
  h.meter.onUsage(receipt(0.002));
  const end = h.meter.finish(); h.meter.finish({ ok: false });
  assert.equal(end.receipts, 2); assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].cost_usd, 0.003); assert.equal(h.rows[0].cost_cap_usd, 0.003);
  assert.equal(h.rows[0].tokens_out, 100); // reasoning is already included in output usage
  assert.equal(h.rows[0].ok, 2); assert.equal(h.rows[0].failed, 0); assert.ok(h.rows[0].finished_at);
});

test('paid failures are on the ledger before finish and are not booked again while reporting failure', () => {
  const h = fixture(), paid = receipt();
  h.meter.onUsage(paid);
  assert.equal(h.rows[0].cost_usd, 0.001);
  h.meter.onUsage(paid); // the exact same callback receipt cannot double-charge
  h.meter.finish({ ok: false });
  assert.equal(h.rows[0].items, 1); assert.equal(h.rows[0].failed, 1); assert.equal(h.rows[0].ok, 0);
  assert.equal(h.rows[0].cost_usd, 0.001);
});

test('equal-valued distinct answers are both recorded, including unknown-price cap estimates', () => {
  const h = fixture(); h.meter.onUsage(receipt(null, 0.01)); h.meter.onUsage(receipt(null, 0.01));
  h.meter.finish();
  assert.equal(h.rows[0].items, 2); assert.equal(h.rows[0].cost_usd, 0); assert.equal(h.rows[0].cost_cap_usd, 0.02);
});

test('failed connection attempts with no receipt do not create a charge row', () => {
  const h = fixture(); h.meter.onUsage(null); h.meter.finish({ ok: false });
  assert.equal(h.rows.length, 0);
});

test('the receipt month is used even when the meter was prepared during the previous month', () => {
  const h = fixture(), nextMonth = new Date(2026, 10, 1, 0, 0, 1).getTime();
  h.setTime(nextMonth); h.meter.onUsage(receipt()); h.meter.finish();
  assert.equal(h.rows[0].started_at, nextMonth); assert.equal(h.rows[0].finished_at, nextMonth);
});

test('late usage is preserved without reopening a finished failed request', () => {
  const h = fixture(); h.meter.finish({ ok: false }); h.meter.onUsage(receipt());
  assert.equal(h.rows[0].items, 1); assert.equal(h.rows[0].failed, 1); assert.equal(h.rows[0].ok, 0);
  assert.equal(h.rows[0].cost_usd, 0.001); assert.ok(h.rows[0].finished_at);
});

test('a failed ledger write can be retried without losing or double-counting a receipt', () => {
  const h = fixture(), original = h.store.updateRun, paid = receipt();
  let failOnce = true;
  h.store.updateRun = (id, patch) => {
    if (patch.cost_usd !== undefined && failOnce) { failOnce = false; throw Error('fixture write failed'); }
    original(id, patch);
  };
  assert.throws(() => h.meter.onUsage(paid), /fixture write failed/);
  h.meter.onUsage(paid); h.meter.finish();
  assert.equal(h.rows.length, 1); assert.equal(h.rows[0].items, 1); assert.equal(h.rows[0].cost_usd, 0.001);
});

test('invalid negative and nonfinite receipt counters cannot lower existing usage', () => {
  const h = fixture(); h.meter.onUsage(receipt());
  h.meter.onUsage({ usage: { in: -900, out: Infinity }, cost: -10, costCap: NaN }); h.meter.finish();
  assert.equal(h.rows[0].tokens_in, 120); assert.equal(h.rows[0].tokens_out, 50);
  assert.equal(h.rows[0].cost_usd, 0.001); assert.equal(h.rows[0].cost_cap_usd, 0.001);
});
