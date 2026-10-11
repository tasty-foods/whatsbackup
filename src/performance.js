'use strict';
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
setInterval(() => lag.reset(), 30000).unref();
module.exports = () => ({
  engineMemoryMB: Math.round(process.memoryUsage().rss / 1048576),
  pcFreeMemoryMB: Math.round(os.freemem() / 1048576),
  pcTotalMemoryMB: Math.round(os.totalmem() / 1048576),
  loopP95Ms: Math.round(lag.percentile(95) / 1e6),
  loopMaxMs: Math.round(lag.max / 1e6),
  uptimeSeconds: Math.round(process.uptime()),
});
