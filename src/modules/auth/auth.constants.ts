export const AUTH = {
  JWT_EXPIRES_IN: "7d",
  BCRYPT_SALT_ROUNDS: 10,
} as const;

export const PASSWORD_POLICY = {
  MIN_LENGTH: 8,
  MAX_LENGTH: 128,
} as const;

export const EMAIL_MAX_LENGTH = 254;
