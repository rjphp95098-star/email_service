import { WebhookService } from "./webhook.service";

const ROW = {
  autoId: 10,
  tempGroupId: 5,
  groupExcelid: 12,
  emailStatus: "PROCESSED",
  emailCount: 0,
  errordetails: "",
};

function buildService() {
  const webhookEventService = {
    create: jest.fn().mockResolvedValue(true),
  };
  const prisma = {
    userEmail: {
      findUnique: jest.fn().mockResolvedValue(ROW),
      // Prisma's update() returns the full updated row by default (no
      // `select` used at any of these call sites) - the mock mirrors that
      // so notifyRowChanged() has real values to read.
      update: jest.fn().mockImplementation(
        ({
          data,
        }: {
          data: Partial<typeof ROW> & {
            emailCount?: { increment: number };
          };
        }) => {
          const emailCount =
            typeof data.emailCount?.increment === "number"
              ? ROW.emailCount + data.emailCount.increment
              : ROW.emailCount;

          return Promise.resolve({ ...ROW, ...data, emailCount });
        },
      ),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(ROW),
    },
    templateGroup: {
      findUnique: jest.fn().mockResolvedValue({ isAi: 0 }),
    },
    unsubscribeUserEmail: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
    },
  };
  const emailStatusGateway = {
    notifyRowChanged: jest.fn(),
  };

  const service = new WebhookService(
    webhookEventService as any,
    prisma as any,
    emailStatusGateway as any,
  );

  return { service, prisma, webhookEventService, emailStatusGateway };
}

describe("WebhookService.processEvents - status priority update", () => {
  it("notifies the row's batch room when a higher-priority status is written", async () => {
    const { service, prisma, emailStatusGateway } = buildService();
    prisma.userEmail.findUnique.mockResolvedValue({
      ...ROW,
      emailStatus: "PROCESSED",
    });

    await service.processEvents([
      { event: "delivered", auto_id: "10", timestamp: 1700000000 },
    ]);

    expect(prisma.userEmail.update).toHaveBeenCalledWith({
      where: { autoId: 10 },
      data: { emailStatus: "DELIVERED" },
    });
    expect(emailStatusGateway.notifyRowChanged).toHaveBeenCalledWith({
      autoId: 10,
      tempGroupId: 5,
      groupExcelid: 12,
      emailStatus: "DELIVERED",
      previousEmailStatus: "PROCESSED",
      emailCount: 0,
      errordetails: "",
    });
  });

  it("does not notify when the incoming status is not higher priority", async () => {
    const { service, prisma, emailStatusGateway } = buildService();
    prisma.userEmail.findUnique.mockResolvedValue({
      ...ROW,
      emailStatus: "OPENED",
    });

    await service.processEvents([
      { event: "delivered", auto_id: "10", timestamp: 1700000000 },
    ]);

    expect(prisma.userEmail.update).not.toHaveBeenCalled();
    expect(emailStatusGateway.notifyRowChanged).not.toHaveBeenCalled();
  });
});

describe("WebhookService.processEvents - open count", () => {
  it("notifies the row's batch room on an open event", async () => {
    const { service, prisma, emailStatusGateway } = buildService();

    await service.processEvents([
      { event: "open", auto_id: "10", timestamp: 1700000000 },
    ]);

    expect(prisma.userEmail.update).toHaveBeenCalledWith({
      where: { autoId: 10 },
      data: { emailCount: { increment: 1 } },
    });
    expect(emailStatusGateway.notifyRowChanged).toHaveBeenCalledWith({
      autoId: 10,
      tempGroupId: 5,
      groupExcelid: 12,
      emailStatus: "PROCESSED",
      emailCount: 1,
      errordetails: "",
    });
  });
});

describe("WebhookService.processEvents - failure errordetails", () => {
  it("notifies the row's batch room when a failure event writes errordetails", async () => {
    const { service, prisma, emailStatusGateway } = buildService();

    await service.processEvents([
      {
        event: "dropped",
        auto_id: "10",
        timestamp: 1700000000,
        reason: "mailbox full",
      },
    ]);

    expect(prisma.userEmail.update).toHaveBeenCalledWith({
      where: { autoId: 10 },
      data: { errordetails: "mailbox full" },
    });
    expect(emailStatusGateway.notifyRowChanged).toHaveBeenCalledWith({
      autoId: 10,
      tempGroupId: 5,
      groupExcelid: 12,
      emailStatus: "PROCESSED",
      emailCount: 0,
      errordetails: "mailbox full",
    });
  });
});

describe("WebhookService.processEvents - no user_emails row", () => {
  it("never notifies when auto_id can't be resolved", async () => {
    const { service, prisma, emailStatusGateway } = buildService();
    prisma.userEmail.findUnique.mockResolvedValue(null);
    prisma.userEmail.findFirst.mockResolvedValue(null);

    await service.processEvents([{ event: "open", timestamp: 1700000000 }]);

    expect(emailStatusGateway.notifyRowChanged).not.toHaveBeenCalled();
  });
});

describe("WebhookService.processEvents - duplicate webhook delivery", () => {
  it("skips every side effect for a sg_event_id already stored (a retried delivery)", async () => {
    const { service, prisma, webhookEventService, emailStatusGateway } =
      buildService();
    webhookEventService.create.mockResolvedValue(false);

    await service.processEvents([
      {
        event: "open",
        auto_id: "10",
        timestamp: 1700000000,
        sg_event_id: "evt_1",
      },
    ]);

    expect(webhookEventService.create).toHaveBeenCalledWith(
      expect.objectContaining({ guid: "evt_1" }),
    );
    expect(prisma.userEmail.update).not.toHaveBeenCalled();
    expect(emailStatusGateway.notifyRowChanged).not.toHaveBeenCalled();
  });
});

describe("WebhookService.processEvents - AI sequence bounce retry", () => {
  const NOW = new Date("2026-09-23T10:00:00Z");
  const TOMORROW = new Date("2026-09-24T10:00:00Z");

  const bounce = {
    event: "bounce",
    auto_id: "10",
    timestamp: 1700000000,
    status: "5.1.1",
    type: "bounce",
    reason: "550 5.1.1 user unknown",
  };

  function buildAiService(bouncesSoFar: number) {
    const built = buildService();
    built.prisma.templateGroup.findUnique.mockResolvedValue({ isAi: 1 });
    built.prisma.webhookEvent.count.mockResolvedValue(bouncesSoFar);
    return built;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([1, 2])(
    "re-queues the same row for tomorrow on bounce #%i",
    async (bouncesSoFar) => {
      const { service, prisma } = buildAiService(bouncesSoFar);

      await service.processEvents([bounce]);

      expect(prisma.webhookEvent.count).toHaveBeenCalledWith({
        where: { userEmailId: 10, eventType: "bounce" },
      });
      expect(prisma.userEmail.update).toHaveBeenCalledWith({
        where: { autoId: 10 },
        data: {
          isSend: 0,
          emailStatus: null,
          followDate: TOMORROW,
          sendGridId: null,
          sentDate: null,
        },
      });
      expect(prisma.unsubscribeUserEmail.create).not.toHaveBeenCalled();
      expect(prisma.userEmail.delete).not.toHaveBeenCalled();
    },
  );

  it("never creates a second user_emails row for the retry", async () => {
    const { service, prisma } = buildAiService(1);
    (prisma.userEmail as any).create = jest.fn();

    await service.processEvents([bounce]);

    expect((prisma.userEmail as any).create).not.toHaveBeenCalled();
  });

  it("leaves email_status NULL instead of writing BOUNCED once the retry is queued", async () => {
    const { service, prisma } = buildAiService(1);

    await service.processEvents([bounce]);

    expect(prisma.userEmail.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailStatus: "BOUNCED" } }),
    );
  });

  it("notifies the UI with the re-queued row", async () => {
    const { service, emailStatusGateway } = buildAiService(1);

    await service.processEvents([bounce]);

    expect(emailStatusGateway.notifyRowChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        autoId: 10,
        isSend: 0,
        emailStatus: null,
      }),
    );
  });

  it("unsubscribes instead of retrying on bounce #3", async () => {
    const { service, prisma } = buildAiService(3);

    await service.processEvents([bounce]);

    expect(prisma.userEmail.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isSend: 0 }),
      }),
    );
    expect(prisma.unsubscribeUserEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userEmailId: 10, unsubscribe: 1 }),
    });
    expect(prisma.userEmail.delete).toHaveBeenCalledWith({
      where: { autoId: 10 },
    });
  });

  it("does not retry a non-AI row - it unsubscribes as before", async () => {
    const { service, prisma } = buildService();

    await service.processEvents([bounce]);

    expect(prisma.webhookEvent.count).not.toHaveBeenCalled();
    expect(prisma.unsubscribeUserEmail.create).toHaveBeenCalled();
  });

  it("writes BOUNCED as usual when the bounce is not a retryable one", async () => {
    const { service, prisma } = buildAiService(1);

    await service.processEvents([{ ...bounce, status: "5.7.1" }]);

    expect(prisma.webhookEvent.count).not.toHaveBeenCalled();
    expect(prisma.unsubscribeUserEmail.create).toHaveBeenCalled();
    expect(prisma.userEmail.update).toHaveBeenCalledWith({
      where: { autoId: 10 },
      data: { emailStatus: "BOUNCED" },
    });
  });
});

describe("WebhookService.processEvents - spam report", () => {
  const spamreport = {
    event: "spamreport",
    auto_id: "10",
    timestamp: 1700000000,
  };

  it.each([
    ["AI sequence", 1],
    ["non-AI", 0],
  ])("unsubscribes the recipient on a %s row", async (_label, isAi) => {
    const { service, prisma } = buildService();
    prisma.templateGroup.findUnique.mockResolvedValue({ isAi });

    await service.processEvents([spamreport]);

    expect(prisma.unsubscribeUserEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userEmailId: 10, unsubscribe: 1 }),
    });
    expect(prisma.userEmail.delete).toHaveBeenCalledWith({
      where: { autoId: 10 },
    });
  });
});
