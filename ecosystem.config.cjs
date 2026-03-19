module.exports = {
  apps: [
    {
      name: 'atomic-authority',
      script: 'node_modules/.bin/tsx',
      args: 'src/scheduler/index.ts',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 5000,
      max_restarts: 5,
    },
  ],
};
