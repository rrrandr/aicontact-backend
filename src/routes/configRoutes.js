import express from "express";
import crypto from "crypto";
import { config } from "../config/env";
import { logger } from "../util/logger";

/**
 * Remote configuration for future clients.
 *
 * Every released build has its API host compiled in, so moving hosts today
 * means shipping a new build to every store. Clients that read this endpoint
 * can be redirected with a configuration change instead.
 *
 * That makes whatever domain serves this the permanent hardcoded dependency,
 * inheriting the role the current API host holds. It must sit on a domain that
 * will outlive any vendor relationship.
 *
 * The payload is signed so that control of the DNS record is not by itself
 * enough to redirect installed applications to a hostile API. Clients verify
 * with an embedded public key and must reject an unsigned or badly signed
 * response.
 */
const configRouter = express.Router();

const sign = (payload) => {
  if (!config.publicConfig.signingKey) return null;

  try {
    const key = crypto.createPrivateKey(config.publicConfig.signingKey);
    return crypto
      .sign(null, Buffer.from(JSON.stringify(payload)), key)
      .toString("base64");
  } catch (error) {
    logger.error("config signing failed", { error: error.message });
    return null;
  }
};

configRouter.get("/config", (req, res) => {
  const payload = {
    api_base_url: config.publicConfig.apiBaseUrl,
    min_client_version: config.publicConfig.minClientVersion,
    force_upgrade: config.publicConfig.forceUpgrade,
    message: config.publicConfig.message,
    issued_at: new Date().toISOString(),
  };

  res.set("Cache-Control", "public, max-age=300");
  return res.status(200).json({ config: payload, signature: sign(payload) });
});

export default configRouter;
