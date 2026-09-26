import { SendgridConsumer } from "./sendgrid.consumer";

function buildConsumer() {
  const sendgridService = {
    sendRawEmail: jest.fn(),
  };
  const configService = {
    get: jest.fn().mockReturnValue(0), // sendDelay=0 so tests run instantly
  };
  const internalAuthService = {
    verifyToken: jest.fn(),
  };
  const rabbitmqPublisher = {
    publishSendEmail: jest.fn().mockResolvedValue(undefined),
  };

  const consumer = new SendgridConsumer(
    sendgridService as any,
    configService as any,
    internalAuthService as any,
    rabbitmqPublisher as any,
  );

  return { consumer, sendgridService, internalAuthService, rabbitmqPublisher };
}

function buildContext() {
  const channel = { ack: jest.fn(), nack: jest.fn() };
  const message = { fields: {}, properties: {}, content: Buffer.from("") };
  const context = {
    getChannelRef: () => channel,
    getMessage: () => message,
  };
  return { context, channel, message };
}

const basePayload = {
  auto_id: 42,
  recipientEmail: "lead@example.com",
  subject: "Hi",
  htmlContent: "Body",
  settingsId: 5,
  token: "valid-token",
};

describe("SendgridConsumer.handleSendEmail", () => {
  it("acks and does not retry on a successful send", async () => {
    const { consumer, sendgridService, rabbitmqPublisher } = buildConsumer();
    const { context, channel } = buildContext();
    sendgridService.sendRawEmail.mockResolvedValue({
      success: true,
      skippedDuplicate: false,
    });

    await consumer.handleSendEmail(basePayload as any, context as any);

    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
  });

  it("re-queues a retry (ack, not nack) on a transient SendGrid 503, incrementing retryCount", async () => {
    const { consumer, sendgridService, rabbitmqPublisher } = buildConsumer();
    const { context, channel } = buildContext();
    const transientError = Object.assign(new Error("Service Unavailable"), {
      code: 503,
    });
    sendgridService.sendRawEmail.mockRejectedValue(transientError);

    await consumer.handleSendEmail(basePayload as any, context as any);

    expect(channel.nack).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(rabbitmqPublisher.publishSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ auto_id: 42, retryCount: 1 }),
    );
  });

  it("nacks straight to the DLQ on a permanent 400, without retrying", async () => {
    const { consumer, sendgridService, rabbitmqPublisher } = buildConsumer();
    const { context, channel } = buildContext();
    const permanentError = Object.assign(new Error("Bad Request"), {
      code: 400,
    });
    sendgridService.sendRawEmail.mockRejectedValue(permanentError);

    await consumer.handleSendEmail(basePayload as any, context as any);

    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(context.getMessage(), false, false);
  });

  it("nacks to the DLQ once a transient error has already exhausted its retries", async () => {
    const { consumer, sendgridService, rabbitmqPublisher } = buildConsumer();
    const { context, channel } = buildContext();
    const transientError = Object.assign(new Error("Service Unavailable"), {
      code: 503,
    });
    sendgridService.sendRawEmail.mockRejectedValue(transientError);

    await consumer.handleSendEmail(
      { ...basePayload, retryCount: 5 } as any,
      context as any,
    );

    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(context.getMessage(), false, false);
  });

  it("nacks straight to the DLQ on an invalid/expired internal token, without retrying", async () => {
    const { consumer, internalAuthService, rabbitmqPublisher } =
      buildConsumer();
    const { context, channel } = buildContext();
    internalAuthService.verifyToken.mockImplementation(() => {
      throw new Error("Invalid internal token");
    });

    await consumer.handleSendEmail(basePayload as any, context as any);

    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(context.getMessage(), false, false);
  });
});
