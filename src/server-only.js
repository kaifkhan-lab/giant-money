// API/web tier only — pair with src/worker.js for the data pipeline.
process.env.DISABLE_SCHEDULER = '1';
await import('./index.js');
