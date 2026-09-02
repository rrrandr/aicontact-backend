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

  // v1 stays permissive: its clients are native applications that send no
  // Origin at all, and an unknown consumer may exist. v2 gets the allowlist,
  // mounted on its own router below.
  app.use("/api/user", cors({ origin: "*" }));
  app.use("/config", cors({ origin: "*" }));

  const captureRawBody = (req, _res, buf) => {
    // The PayPal webhook signature is computed over the exact bytes sent, not
    // over a re-serialization of the parsed object.
    if (req.originalUrl && req.originalUrl.includes("/webhooks/")) {
      req.rawBody = buf.toString("utf8");
    }
  };

  // Limits are per-route and small by default. A 50MB ceiling on
  // unauthenticated endpoints is free memory pressure for anyone who wants it.
  app.use(
    "/api/v2/webhooks",
    bodyParser.json({ limit: config.bodyLimits.webhook, verify: captureRawBody })
  );
  app.use(
    "/api/v2/entitlements",
    bodyParser.json({ limit: config.bodyLimits.entitlement })
  );
  app.use(bodyParser.json({ limit: config.bodyLimits.default, verify: captureRawBody }));
  app.use(
    bodyParser.urlencoded({ limit: config.bodyLimits.default, extended: true })
  );

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
    // Explicit allowlist. A request with no Origin - every native client - is
    // unaffected; a browser origin that is not listed gets no CORS headers
    // back, so the browser refuses to hand it the response.
    app.use(
      "/api/v2",
      cors({
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          const allowed = config.cors.allowedOrigins;
          return callback(null, allowed.includes(origin) ? origin : false);
        },
        credentials: true,
      }),
      createV2Router()
    );
  }

  app.use(ErrorHandler);

  return app;
};
