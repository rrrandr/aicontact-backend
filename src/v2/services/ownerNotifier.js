import { config } from "../../config/env";
import { logger } from "../../util/logger";
import { sendMail } from "./mailService";

/**
 * Operational notifications to the business owner.
 *
 * Deliberately separate from mailService, which carries customer mail -
 * password resets and subscription confirmations. Routing both through one
 * provider setting would mean that pointing the weekly summary at an SNS topic
 * also pointed every customer's password reset there. These are different
 * audiences and they get different transports.
 *
 * SNS is the intended route because the topic already exists and its
 * subscription to the operations address is already confirmed; nothing new has
 * to be verified, and nothing about who receives it lives in this repository.
 */

// SNS truncates a Subject at 100 characters and rejects newlines and control
// characters outright, so the message is shaped to fit rather than rejected.
const SNS_SUBJECT_LIMIT = 100;

const snsSubject = (subject) =>
  String(subject || "")
    .replace(/[\r\n\t]+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, SNS_SUBJECT_LIMIT);

let cached = null;

const adapters = {
  /**
   * Publishes to the existing operations topic.
   *
   * Credentials come from the instance role, never from configuration: the
   * only thing named here is the topic, and the role is allowed to publish to
   * that topic and nothing else.
   */
  sns: async (message) => {
    const topicArn = config.ownerReport.snsTopicArn;
    if (!topicArn) {
      throw new Error("OWNER_REPORT_SNS_TOPIC_ARN is not set");
    }

    // Imported on use, so a deployment that does not publish to SNS never
    // loads the SDK.
    if (!cached) {
      const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");
      cached = {
        client: new SNSClient({ region: config.ownerReport.region }),
        PublishCommand,
      };
    }

    const result = await cached.client.send(
      new cached.PublishCommand({
        TopicArn: topicArn,
        Subject: snsSubject(message.subject),
        Message: message.text,
      })
    );

    return { delivered: true, adapter: "sns", id: result.MessageId };
  },

  /** The transactional mail provider, when one is configured. */
  mail: async (message) => {
    const to = config.ownerReport.to;
    if (!to) throw new Error("OWNER_REPORT_TO is not set");
    return sendMail({ to, subject: message.subject, text: message.text });
  },

  /**
   * Development and test. Reports delivered: false, which callers treat as a
   * failed delivery rather than a delivery - see weeklyReportService.
   */
  log: async (message) => {
    logger.info("owner notification (not sent - transport is \"log\")", {
      subject: message.subject,
    });
    return { delivered: false, adapter: "log" };
  },
};

/** Where a notification would go, for logging and for boot-time checks. */
export const destination = () => {
  switch (config.ownerReport.transport) {
    case "sns":
      return config.ownerReport.snsTopicArn || null;
    case "mail":
      return config.ownerReport.to || null;
    default:
      return null;
  }
};

export const notifyOwner = async (message) => {
  const transport = config.ownerReport.transport;
  const adapter = adapters[transport] || adapters.log;
  return adapter(message);
};

// Tests and long-running processes that change region between runs.
export const resetTransport = () => {
  cached = null;
};
