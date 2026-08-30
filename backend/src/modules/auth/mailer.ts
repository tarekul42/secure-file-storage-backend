import { logger } from "../../utils/logger.js";

export interface Mailer {
  sendPasswordReset(to: string, resetUrl: string): Promise<void>;
}

// Development-only mailer that logs the reset link so no real
// mail infrastructure is required while iterating.
export const devMailer: Mailer = {
  async sendPasswordReset(to, resetUrl) {
    logger.info({ to, resetUrl }, "password reset link (dev mode)");
  },
};
