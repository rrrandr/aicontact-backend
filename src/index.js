import { createApp } from "./app";
import { config, assertV2Config } from "./config/env";
import { connectDB, disconnectDB } from "./util/db";
import { logger } from "./util/logger";
import { startMaintenance } from "./v2/services/maintenanceService";
import { destination as ownerDestination } from "./v2/services/ownerNotifier";

const start = async () => {
  // Fail fast. The previous implementation started listening regardless of
  // whether the database was reachable and reported success either way.
  // Validate v2 configuration before opening a socket, so a missing Apple key
  // is a boot failure rather than a failed purchase.
  if (config.v2Enabled) assertV2Config();

  await connectDB();

  // Turned on but unable to send: worth saying at boot rather than leaving
  // someone to notice that a weekly summary never arrives.
  if (config.ownerReport.enabled) {
    if (config.ownerReport.transport === "log") {
      logger.warn(
        "weekly report is enabled but OWNER_REPORT_TRANSPORT is \"log\", which does not " +
          "send; reports will be retained and retried, not delivered"
      );
    } else if (!ownerDestination()) {
      logger.warn("weekly report is enabled but its transport has no destination", {
        transport: config.ownerReport.transport,
      });
    } else {
      logger.info("weekly report enabled", {
        transport: config.ownerReport.transport,
        timezone: config.ownerReport.timeZone,
      });
    }
  }

  // Retention enforcement and cancellation recovery. Without this the
  // retention periods would be configuration and nothing more.
  const stopMaintenance = config.v2Enabled ? startMaintenance() : () => {};

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info("aicontact backend listening", {
      port: config.port,
      env: config.env,
    });
  });

  const shutdown = async (signal) => {
    logger.info("shutting down", { signal });
    stopMaintenance();
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
