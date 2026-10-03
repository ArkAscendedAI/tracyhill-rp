import bcrypt from "bcryptjs";

export function comparePassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

// bcrypt hashes only the first 72 BYTES of the input; everything after is
// silently ignored, so two passwords that differ past that point are
// interchangeable. Validation used to allow 128 chars.
// Existing longer passwords still verify (compare truncates identically) —
// only NEW passwords are held to the real limit.
export const PASSWORD_MAX_BYTES = 72;

export function validatePassword(password: string) {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return `Password must be ${PASSWORD_MAX_BYTES} bytes or fewer (about ${PASSWORD_MAX_BYTES} characters)`;
  if (!/[a-z]/.test(password)) return "Password must include a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must include an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must include a number";
  return null;
}

export function validateUsername(username: string) {
  if (!username) return "Username is required";
  if (username.length < 2 || username.length > 30) return "Username must be 2-30 characters";
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return "Username can only contain letters, numbers, hyphens, and underscores";
  return null;
}

export function validateEmail(email: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return "Valid email address required";
  return null;
}
