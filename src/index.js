import { createApp } from "./app";
import { config, assertV2Config } from "./config/env";
import { connectDB, disconnectDB } from "./util/db";
import { logger } from "./util/logger";

const start = async () => {
  // Fail fast. The previous implementation started listening regardless of
  // whether the database was reachable and reported success either way.
  // Validate v2 configuration before opening a socket, so a missing Apple key
  // is a boot failure rather than a failed purchase.
  if (config.v2Enabled) assertV2Config();

  await connectDB();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info("aicontact backend listening", {
      port: config.port,
      env: config.env,
    });
  });

  const shutdown = async (signal) => {
    logger.info("shutting down", { signal });
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

start().catch((error) => {
  logger.error("failed to start", { error: error.message });
  process.exit(1);
});
