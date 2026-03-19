module.exports = {
  apps: [
    {
      name: 'atomic-authority',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/scheduler/index.ts',
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 5,
    },
  ],
};
