import { newPasswordError } from "../../util/passwordPolicy";

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.statusCode = 400;
    this.code = "invalid_request";
    this.field = field;
  }
}

export const requireString = (value, field, { min = 1, max = 4096 } = {}) => {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`, field);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new ValidationError(`${field} is required`, field);
  }
  if (trimmed.length > max) {
    throw new ValidationError(`${field} is too long`, field);
  }
  return trimmed;
};

// Prefer long passphrases and a blocklist over composition rules, which push
// people toward predictable substitutions without adding reliable entropy.
export const requirePassword = (value, field = "password") => {
  const error = newPasswordError(value);
  if (error) throw new ValidationError(error, field);
  return value;
};
