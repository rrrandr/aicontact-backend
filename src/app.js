import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import ErrorHandler from "./middlewears/errorHandler";
import userRouter from "./routes/userRoutes";
import configRouter from "./routes/configRoutes";
import { createV2Router } from "./v2/routes";
import { config } from "./config/env";
import { logger } from "./util/logger";

// Split out from index.js so tests can mount the app without binding a port
// or opening a database connection of its own.
export const createApp = () => {
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet());

  // Left open deliberately. The clients are native applications that send no
  // Origin header, so restricting this buys nothing on v1 while risking an
  // unknown consumer. v2 sets an explicit allowlist.
  app.use(cors({ origin: "*" }));

  // The raw body is kept for the PayPal webhook, whose signature is computed
  // over the exact bytes sent rather than a re-serialization of them.
  app.use(
    bodyParser.json({
      limit: "50mb",
      verify: (req, _res, buf) => {
        if (req.originalUrl && req.originalUrl.includes("/webhooks/")) {
          req.rawBody = buf.toString("utf8");
        }
      },
    })
  );
  app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.set("X-API-Version", "1");
    res.on("finish", () => {
      logger.info("request", {
        api_version: 1,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });
    next();
  });

  app.get("/healthz", (req, res) => res.status(200).json({ status: "ok" }));

  app.get("/readyz", (req, res) => {
    const ready = mongoose.connection.readyState === 1;
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? "ready" : "not-ready" });
  });

  app.use(configRouter);
  app.use("/api/user", userRouter);

  if (config.v2Enabled) {
    app.use("/api/v2", createV2Router());
  }

  app.use(ErrorHandler);

  return app;
};
