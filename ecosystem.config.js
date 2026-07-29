module.exports = {
  apps: [
    {
      name: "synapse",
      script: "api/server/index.js",
      cwd: "/opt/synapse",
      instances: 2,
      exec_mode: "cluster",
      max_memory_restart: "2G",
      env: { NODE_ENV: "production" },
    },
    {
      name: "synapse-admin",
      script: "/home/bdren/.bun/bin/bun",
      args: "server.ts",
      cwd: "/opt/synapse-admin",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOST: "127.0.0.1",
        VITE_BASE_PATH: "/adminpanel",
        VITE_API_BASE_URL: "https://chat.bdren.ai",
      },
    },
  ],
};
