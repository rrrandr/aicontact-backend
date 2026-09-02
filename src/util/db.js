import mongoose from "mongoose";
import { config } from "../config/env";
import { logger } from "./logger";

// Pin the Mongoose 6 default explicitly rather than inheriting a deprecation
// warning; revisit when the driver is upgraded.
mongoose.set("strictQuery", true);

// The previous implementation was async but never awaited mongoose.connect,
// so its try/catch caught nothing and it logged success even when the
// database was unreachable. Every failure surfaced later as a 500.
export const connectDB = async (uri = config.mongoUri) => {
  mongoose.connection.on("connected", () =>
    logger.info("database connected", { host: mongoose.connection.host })
  );
  mongoose.connection.on("disconnected", () =>
    logger.warn("database disconnected")
  );
  mongoose.connection.on("error", (err) =>
    logger.error("database error", { error: err.message })
  );

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  return mongoose.connection;
};

export const disconnectDB = async () => {
  await mongoose.connection.close();
};
