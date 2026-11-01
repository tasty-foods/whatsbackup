'use strict';

// Standalone searches and connection tests do not belong to the queue's run.
// Record their receipts as they arrive, including paid answers that later fail
// validation. The queue already has its own meter and must not use this one.
function createRequestMeter({ store, kind, provider, model, now = Date.now }) {
  if (!store || typeof store.startRun !== 'function' || typeof store.updateRun !== 'function') {
    throw new TypeError('A usage ledger is required.');
  }
  const seen = new WeakSet();
  let id = null, finished = false, succeeded = true, receipts = 0;
  let tokensIn = 0, tokensOut = 0, cost = 0, costCap = 0;
  const amount = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const totals = () => ({ tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost, cost_cap_usd: costCap });
  const outcome = count => ({ items: count, ok: succeeded ? count : 0, failed: succeeded ? 0 : 1 });

  function onUsage(receipt) {
    if (!receipt || typeof receipt !== 'object' || seen.has(receipt)) return;
    const next = {
      tokens_in: tokensIn + amount(receipt.usage?.in),
      tokens_out: tokensOut + amount(receipt.usage?.out),
      cost_usd: cost + amount(receipt.cost),
      // An unknown reported price is still charged against the application
      // budget using the provider's conservative costCap estimate.
      cost_cap_usd: costCap + Math.max(amount(receipt.cost), amount(receipt.costCap)),
    };
    if (id === null) {
      id = store.startRun(kind, model, provider);
      // Date the standalone run by its first receipt, so preparing a request
      // before the month changes does not put its usage in the previous month.
      store.updateRun(id, { started_at: now() });
    }
    store.updateRun(id, { ...next, items: receipts + 1,
      ...(finished ? { ...outcome(receipts + 1), finished_at: now() } : {}) });
    tokensIn = next.tokens_in; tokensOut = next.tokens_out;
    cost = next.cost_usd; costCap = next.cost_cap_usd;
    receipts++;
    seen.add(receipt);
  }

  function finish({ ok = true } = {}) {
    // A late receipt must still be accounted for, but finishing twice must not
    // rewrite the result or create a second ledger row.
    if (!finished) {
      succeeded = ok !== false;
      if (id !== null) store.updateRun(id, { ...totals(), ...outcome(receipts), finished_at: now() });
      finished = true;
    }
    return { id, receipts, ...totals() };
  }

  return { onUsage, finish };
}

module.exports = { createRequestMeter };
