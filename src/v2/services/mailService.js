import { config } from "../../config/env";
import { logger } from "../../util/logger";

/**
 * Vendor-neutral transactional email.
 *
 * No provider has been chosen yet, so the default adapter logs instead of
 * sending. Adding a provider means one function here and one environment
 * variable; nothing else in the codebase knows which service is in use.
 */

const adapters = {
  // Development and test. Never used when NODE_ENV is production.
  log: async (message) => {
    logger.info("email (not sent - no provider configured)", {
      to: message.to,
      subject: message.subject,
    });
    return { delivered: false, adapter: "log" };
  },

  resend: async (message) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.mail.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.mail.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend returned ${response.status}`);
    }
    return { delivered: true, adapter: "resend" };
  },

  postmark: async (message) => {
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": config.mail.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        From: config.mail.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Postmark returned ${response.status}`);
    }
    return { delivered: true, adapter: "postmark" };
  },
};

export const sendMail = async (message) => {
  const adapter = adapters[config.mail.provider] || adapters.log;
  return adapter(message);
};

export const sendPasswordReset = async ({ to, token }) => {
  const link = config.mail.resetUrlBase
    ? `${config.mail.resetUrlBase}?token=${encodeURIComponent(token)}`
    : null;

  return sendMail({
    to,
    subject: "Reset your AICONTACT password",
    text: link
      ? `Use this link within 30 minutes to set a new password:\n\n${link}\n\nIf you did not ask for this, no action is needed.`
      : `Use this code within 30 minutes to set a new password:\n\n${token}\n\nIf you did not ask for this, no action is needed.`,
  });
};
