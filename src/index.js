// GIANT MONEY — API server + always-on backend scheduler in one process.
// The scheduler runs regardless of connected users; see src/scheduler.js.
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { log } from './util.js';

const PORT = Number(process.env.PORT || 4600);

createServer().listen(PORT, () => log('server', `GIANT MONEY listening on http://localhost:${PORT}`));

if (process.env.DISABLE_SCHEDULER !== '1') {
  startScheduler();
} else {
  log('server', 'scheduler disabled in this process (DISABLE_SCHEDULER=1) — run `npm run worker` separately');
}
