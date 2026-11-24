#!/usr/bin/env node

/**
 * Standalone launcher kept for parity with cmd_tools/doc-server. The DSH
 * plugin starts the same `createDocServer` implementation per Session; this
 * file is only for running the copied implementation by hand.
 *
 *   node server/standalone.js [port] [root]
 */
const os = require("os");
const path = require("path");
const { createDocServer } = require("./lib/server");
const { createConfig } = require("./lib/config");

const port = Number(process.argv[2] || process.env.DOC_SERVER_PORT || 4179);
const root = path.resolve(process.argv[3] || process.env.DOC_SERVER_ROOT || process.cwd());
const config = createConfig({ root, port });
const server = createDocServer(config);

server.listen(config.port, "0.0.0.0", () => {
  const actualPort = server.address().port;
  console.log(`Doc graph server: http://127.0.0.1:${actualPort}`);
  const addresses = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter((info) => info && !info.internal && (info.family === "IPv4" || info.family === 4))
      .map((info) => info.address)
  );
  for (const address of addresses) {
    console.log(`LAN: http://${address}:${actualPort}`);
  }
  console.log(`Serving: ${config.root}`);
  console.log(`Graph node files: ${config.graphFileNames.join(", ")}`);
});
