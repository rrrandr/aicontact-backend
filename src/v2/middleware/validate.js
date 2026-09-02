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

// Length is the only rule that reliably correlates with strength, so it is
// the only one enforced. Composition rules push people toward predictable
// substitutions without adding real entropy.
export const requirePassword = (value, field = "password") => {
  if (typeof value !== "string") {
    throw new ValidationError("password must be a string", field);
  }
  if (value.length < 8) {
    throw new ValidationError("Password must be at least 8 characters.", field);
  }
  if (value.length > 200) {
    throw new ValidationError("Password must be at most 200 characters.", field);
  }
  return value;
};
