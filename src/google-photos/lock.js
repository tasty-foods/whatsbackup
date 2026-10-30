'use strict';
// One runtime lease across browser, Takeout and official Picker operations.
// Never persisted: a process restart cannot leave a stale archive lock.
let owner = null;
function acquire(label) {
  if (owner) return null;
  const ticket = { label }; owner = ticket;
  return () => { if (owner === ticket) owner = null; };
}
module.exports = { acquire, busy: () => !!owner };
