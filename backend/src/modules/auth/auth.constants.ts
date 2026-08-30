export const AUTH = {
  JWT_EXPIRES_IN: "15m",
  REFRESH_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  // Reset tokens expire after this window.
  RESET_TOKEN_TTL_MS: 15 * 60 * 1000,
  BCRYPT_SALT_ROUNDS: 10,
} as const;

export const PASSWORD_POLICY = {
  MIN_LENGTH: 8,
  MAX_LENGTH: 128,
} as const;

export const EMAIL_MAX_LENGTH = 254;
