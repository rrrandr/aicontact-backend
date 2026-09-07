export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

const blockedPasswords = new Set([
  "12345678",
  "123456789",
  "1234567890",
  "123456789012345",
  "admin",
  "adminadminadmin",
  "iloveyou",
  "letmein",
  "password",
  "password123",
  "passwordpassword",
  "qwerty",
  "qwerty123",
  "qwertyuiopasdfgh",
  "welcome",
]);

const characterCount = (value) => Array.from(value.normalize("NFC")).length;

export const newPasswordError = (value) => {
  if (typeof value !== "string") return "Password must be a string.";

  const length = characterCount(value);
  if (length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters. A passphrase is welcome.`;
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }

  if (blockedPasswords.has(value.normalize("NFC").trim().toLowerCase())) {
    return "Choose a less common password.";
  }
  return null;
};
