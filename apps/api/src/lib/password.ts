import bcrypt from "bcryptjs";

export function comparePassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function validatePassword(password: string) {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be 128 characters or fewer";
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
