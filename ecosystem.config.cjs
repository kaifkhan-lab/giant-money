// PM2 production config: `pm2 start ecosystem.config.cjs`
// Two options:
//  - default single app (server + scheduler in one process)
//  - or comment it out and use the split server/worker pair below.
module.exports = {
  apps: [
    {
      name: 'giant-money',
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production', PORT: 4600 },
    },
    // Split deployment (uncomment, and remove the app above):
    // { name: 'giant-money-web', script: 'src/server-only.js', instances: 1, env: { NODE_ENV: 'production', PORT: 4600 } },
    // { name: 'giant-money-worker', script: 'src/worker.js', instances: 1, autorestart: true },
  ],
};
