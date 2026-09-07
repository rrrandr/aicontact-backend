import { notifyOwner, destination, resetTransport } from "../../src/v2/services/ownerNotifier";
import * as mailService from "../../src/v2/services/mailService";

// Jest requires a mock-prefixed name for anything a module factory closes over.
const mockSend = jest.fn();

// The SDK is only reached through this, so the test never touches AWS.
jest.mock("@aws-sdk/client-sns", () => ({
  SNSClient: jest.fn().mockImplementation(() => ({ send: (...args) => mockSend(...args) })),
  PublishCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const TOPIC = "arn:aws:sns:us-east-2:851725546085:AICONTACT-Production-Alerts";

describe("owner notifications", () => {
  const original = { ...process.env };

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ MessageId: "msg-1" });
    resetTransport();
  });

  afterEach(() => {
    process.env.OWNER_REPORT_TRANSPORT = original.OWNER_REPORT_TRANSPORT;
    process.env.OWNER_REPORT_SNS_TOPIC_ARN = original.OWNER_REPORT_SNS_TOPIC_ARN;
    process.env.OWNER_REPORT_TO = original.OWNER_REPORT_TO;
    resetTransport();
  });

  describe("choosing a transport", () => {
    it("sends nothing by default", async () => {
      process.env.OWNER_REPORT_TRANSPORT = "";
      const result = await notifyOwner({ subject: "s", text: "t" });
      expect(result.delivered).toBe(false);
      expect(result.adapter).toBe("log");
      expect(destination()).toBeNull();
    });

    it("publishes to the configured topic when set to sns", async () => {
      process.env.OWNER_REPORT_TRANSPORT = "sns";
      process.env.OWNER_REPORT_SNS_TOPIC_ARN = TOPIC;

      const result = await notifyOwner({
        subject: "AICONTACT weekly billing summary: week",
        text: "counts",
      });

      expect(result.delivered).toBe(true);
      expect(result.adapter).toBe("sns");
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].input).toEqual({
        TopicArn: TOPIC,
        Subject: "AICONTACT weekly billing summary: week",
        Message: "counts",
      });
      expect(destination()).toBe(TOPIC);
    });

    it("refuses to publish when no topic is named", async () => {
      process.env.OWNER_REPORT_TRANSPORT = "sns";
      process.env.OWNER_REPORT_SNS_TOPIC_ARN = "";

      await expect(notifyOwner({ subject: "s", text: "t" })).rejects.toThrow(
        "OWNER_REPORT_SNS_TOPIC_ARN"
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("goes through the mail provider when set to mail", async () => {
      process.env.OWNER_REPORT_TRANSPORT = "mail";
      process.env.OWNER_REPORT_TO = "owner@example.invalid";
      const sendMail = jest
        .spyOn(mailService, "sendMail")
        .mockResolvedValue({ delivered: true, adapter: "resend" });

      await notifyOwner({ subject: "s", text: "t" });

      expect(sendMail).toHaveBeenCalledWith({
        to: "owner@example.invalid",
        subject: "s",
        text: "t",
      });
      expect(mockSend).not.toHaveBeenCalled();
      sendMail.mockRestore();
    });
  });

  describe("shaping the message for SNS", () => {
    beforeEach(() => {
      process.env.OWNER_REPORT_TRANSPORT = "sns";
      process.env.OWNER_REPORT_SNS_TOPIC_ARN = TOPIC;
    });

    it("keeps the subject inside SNS's hundred-character limit", async () => {
      await notifyOwner({ subject: "x".repeat(180), text: "t" });
      expect(mockSend.mock.calls[0][0].input.Subject.length).toBe(100);
    });

    it("strips the newlines and non-ASCII SNS rejects", async () => {
      await notifyOwner({ subject: "week\nof\tthings — done", text: "t" });
      const subject = mockSend.mock.calls[0][0].input.Subject;
      expect(subject).not.toMatch(/[\r\n\t]/);
      expect(subject).toMatch(/^[\x20-\x7E]*$/);
    });

    it("leaves the body untouched, newlines and all", async () => {
      await notifyOwner({ subject: "s", text: "line one\nline two" });
      expect(mockSend.mock.calls[0][0].input.Message).toBe("line one\nline two");
    });
  });

  describe("what it does not carry", () => {
    it("names no credentials anywhere in the call", async () => {
      process.env.OWNER_REPORT_TRANSPORT = "sns";
      process.env.OWNER_REPORT_SNS_TOPIC_ARN = TOPIC;

      await notifyOwner({ subject: "s", text: "counts only" });

      // Credentials come from the instance role; the only thing configured is
      // which topic to publish to.
      const serialised = JSON.stringify(mockSend.mock.calls[0][0].input);
      expect(serialised).not.toMatch(/AKIA/);
      expect(serialised.toLowerCase()).not.toContain("secret");
      expect(serialised.toLowerCase()).not.toContain("password");
    });
  });
});
