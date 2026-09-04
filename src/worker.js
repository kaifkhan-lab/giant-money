// Standalone background worker — runs ONLY the scheduler (no HTTP).
// Use together with `npm run server` when you want the data pipeline and the
// web tier in separate processes (e.g. pm2 ecosystem, containers).
import { startScheduler } from './scheduler.js';
import { log } from './util.js';

log('worker', 'starting dedicated background worker');
startScheduler();
// keep the event loop alive forever
setInterval(() => {}, 1 << 30);
