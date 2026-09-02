import { config } from "../config/env";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = () => LEVELS[config.logLevel] ?? LEVELS.info;

// Single-line JSON so the output is greppable and machine-readable without
// pulling in a logging framework.
const emit = (level, message, fields = {}) => {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

export const logger = {
  debug: (message, fields) => emit("debug", message, fields),
  info: (message, fields) => emit("info", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  error: (message, fields) => emit("error", message, fields),
};
