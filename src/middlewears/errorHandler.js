import { isProduction } from "../config/env";
import { logger } from "../util/logger";

// The only error path. Controllers previously called next(error) and then also
// sent their own 500, which threw ERR_HTTP_HEADERS_SENT on every failure.
const ErrorHandler = (err, req, res, next) => {
  const errStatus = err.statusCode || 500;

  // Client errors are expected traffic; only server errors are worth an
  // error-level line, so genuine failures are not buried under 400s.
  const log = errStatus >= 500 ? logger.error : logger.warn;
  log("request failed", {
    method: req.method,
    path: req.path,
    status: errStatus,
    error: err.message,
    ...(errStatus >= 500 ? { stack: err.stack } : {}),
  });

  if (res.headersSent) return next(err);

  return res.status(errStatus).json({
    success: false,
    status: errStatus,
    // Internal failures must not describe themselves to the caller.
    message:
      errStatus >= 500 ? "Something went wrong" : err.message || "Request failed",
    stack: isProduction() ? {} : err.stack,
  });
};

export default ErrorHandler;
