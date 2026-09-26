import { SendgridService } from "./sendgrid.service";
import sgMail from "@sendgrid/mail";

jest.mock("@sendgrid/mail", () => ({
  __esModule: true,
  default: {
    setApiKey: jest.fn(),
    send: jest.fn(),
  },
}));

function buildService() {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === "SENDGRID_API_KEY") return "test-key";
      throw new Error(`unexpected config key ${key}`);
    }),
  };
  const senderAccountService = {
    getSenderById: jest
      .fn()
      .mockResolvedValue({ id: 5, fromEmail: "a@example.com", fromName: "A" }),
    getOrRotateSender: jest.fn(),
    incrementSentCount: jest.fn().mockResolvedValue(undefined),
  };
  const emailSignatureService = {
    appendIfAssigned: jest.fn().mockImplementation((html) => html),
  };
  const prisma = {
    userEmail: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const service = new SendgridService(
    configService as any,
    senderAccountService as any,
    emailSignatureService as any,
    prisma as any,
  );

  return {
    service,
    senderAccountService,
    emailSignatureService,
    prisma,
  };
}

describe("SendgridService.sendRawEmail", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("skips sending when auto_id already has a sendGridId (redelivered RabbitMQ message)", async () => {
    const { service, prisma } = buildService();
    prisma.userEmail.updateMany.mockResolvedValue({ count: 0 });
    prisma.userEmail.findUnique.mockResolvedValue({
      sendGridId: "existing-message-id",
    });

    const result = await service.sendRawEmail({
      recipientEmail: "lead@example.com",
      subject: "Hi",
      htmlContent: "Body",
      autoId: 42,
      settingsId: 5,
    });

    expect(result).toEqual({
      success: true,
      skippedDuplicate: true,
      sendgridMessageId: "existing-message-id",
    });
    expect(sgMail.send).not.toHaveBeenCalled();
    expect(prisma.userEmail.update).not.toHaveBeenCalled();
  });

  it("sends normally, records sendGridId, and marks email_status PROCESSED", async () => {
    const { service, prisma } = buildService();
    (sgMail.send as jest.Mock).mockResolvedValue([
      { headers: { "x-message-id": "new-message-id" } },
    ]);

    const result = await service.sendRawEmail({
      recipientEmail: "lead@example.com",
      subject: "Hi",
      htmlContent: "Body",
      autoId: 42,
      settingsId: 5,
    });

    expect(sgMail.send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      skippedDuplicate: false,
      sendgridMessageId: "new-message-id",
    });
    expect(prisma.userEmail.updateMany).toHaveBeenCalledWith({
      where: { autoId: 42 },
      data: { sendGridId: "new-message-id" },
    });
    expect(prisma.userEmail.update).toHaveBeenNthCalledWith(1, {
      where: { autoId: 42 },
      data: { emailStatus: "QUEUED" },
    });
    expect(prisma.userEmail.update).toHaveBeenNthCalledWith(2, {
      where: { autoId: 42 },
      data: { emailStatus: "PROCESSED" },
    });
  });

  it("marks email_status FAILED when the send throws", async () => {
    const { service, prisma } = buildService();
    (sgMail.send as jest.Mock).mockRejectedValue(new Error("Bad Request"));

    await expect(
      service.sendRawEmail({
        recipientEmail: "lead@example.com",
        subject: "Hi",
        htmlContent: "Body",
        autoId: 42,
        settingsId: 5,
      }),
    ).rejects.toThrow("Bad Request");

    expect(prisma.userEmail.update).toHaveBeenNthCalledWith(2, {
      where: { autoId: 42 },
      data: { emailStatus: "FAILED" },
    });
  });
});
