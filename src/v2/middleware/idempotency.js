import { IdempotencyKey } from "../../models/idempotencyKey";
import { stableHash } from "../../util/crypto";
import { logger } from "../../util/logger";

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Replays the stored response when a request carries an Idempotency-Key that
 * has been seen before.
 *
 * A key reused with a different body is rejected rather than served the old
 * answer: that combination means a client bug, and silently returning an
 * unrelated response would hide it.
 *
 * The header is optional. Clients that omit it simply lose the protection.
 */
export const idempotency = async (req, res, next) => {
  const key = req.get("idempotency-key");
  if (!key) return next();

  const scopedKey = `${req.user ? req.user._id : "anon"}:${req.path}:${key}`;
  const requestHash = stableHash(req.body);

  const existing = await IdempotencyKey.findOne({ key: scopedKey });

  if (existing) {
    if (existing.request_hash !== requestHash) {
      return res.status(409).json({
        status: "Error",
        code: "idempotency_key_reused",
        message: "This Idempotency-Key was already used for a different request.",
      });
    }

    if (existing.status_code) {
      res.set("Idempotent-Replay", "true");
      return res.status(existing.status_code).json(existing.response_body);
    }

    // A record with no response is an in-flight duplicate.
    return res.status(409).json({
      status: "Error",
      code: "request_in_flight",
      message: "An identical request is already being processed.",
    });
  }

  try {
    await IdempotencyKey.create({
      key: scopedKey,
      user_id: req.user ? req.user._id : undefined,
      endpoint: req.path,
      request_hash: requestHash,
      expires_at: new Date(Date.now() + TTL_MS),
    });
  } catch (error) {
    // Unique-index collision: another request won the race.
    return res.status(409).json({
      status: "Error",
      code: "request_in_flight",
      message: "An identical request is already being processed.",
    });
  }

  // Capture the response so a retry can be answered from the record.
  //
  // The write completes BEFORE the response is sent. Storing it in the
  // background instead leaves a window where a fast retry finds a record with
  // no response yet and is told the request is still in flight - which is
  // exactly what a client retrying an entitlement grant would hit.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    IdempotencyKey.updateOne(
      { key: scopedKey },
      { $set: { status_code: res.statusCode, response_body: body } }
    )
      .catch((error) =>
        logger.error("failed to store idempotent response", { error: error.message })
      )
      .finally(() => originalJson(body));
    return res;
  };

  return next();
};
