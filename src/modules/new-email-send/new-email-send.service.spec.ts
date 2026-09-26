import { NewEmailSendService } from "./new-email-send.service";

function buildPrisma() {
  return {
    excelDataUpload: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    templateGroup: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    template: {
      findFirst: jest.fn(),
    },
    groupSignature: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    userEmail: {
      create: jest.fn().mockResolvedValue(undefined),
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    setting: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    groupExcel: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
}

function buildService(prisma: ReturnType<typeof buildPrisma>) {
  const configService = { get: jest.fn().mockReturnValue(undefined) };
  const rabbitmqPublisher = {
    publishSendEmail: jest.fn().mockResolvedValue(undefined),
  };
  const aiRewriteService = { rewrite: jest.fn() };
  const domainRotationService = {
    getActiveDomainForWorkingWeek: jest.fn(),
  };
  const service = new NewEmailSendService(
    prisma as any,
    configService as any,
    rabbitmqPublisher as any,
    aiRewriteService as any,
    domainRotationService as any,
  );

  return { service, configService, rabbitmqPublisher, domainRotationService };
}

describe("NewEmailSendService.migratePendingExcelData", () => {
  it("stores the domain rotation service's resolved domain on the new Initial Email row", async () => {
    const prisma = buildPrisma();
    prisma.excelDataUpload.findMany.mockResolvedValue([
      {
        id: 1,
        name: "Lead",
        email: "lead@example.com",
        groupId: 7,
        groupExcelId: 3,
      },
    ]);
    prisma.templateGroup.findFirst.mockResolvedValue({ id: 7, archive: 0 });
    prisma.template.findFirst.mockResolvedValue({
      tempId: 20,
      tempSubject: "Subject",
      tempDesc: "Body",
      groupSignatureId: 1,
      aiPrompt: null,
    });

    const { service, domainRotationService } = buildService(prisma);
    domainRotationService.getActiveDomainForWorkingWeek.mockResolvedValue({
      id: 555,
      fromEmail: "d2@example.com",
    });

    await service.migratePendingExcelData();

    expect(
      domainRotationService.getActiveDomainForWorkingWeek,
    ).toHaveBeenCalledWith(7);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const createCall = prisma.userEmail.create.mock.calls[0][0] as {
      data: { smtpSettingId: number };
    };
    expect(createCall.data.smtpSettingId).toBe(555);
  });

  it("falls back to the sequence's legacy fixed settings_id when no rotation pool is configured yet", async () => {
    const prisma = buildPrisma();
    prisma.excelDataUpload.findMany.mockResolvedValue([
      {
        id: 1,
        name: "Lead",
        email: "lead@example.com",
        groupId: 7,
        groupExcelId: 3,
      },
    ]);
    prisma.templateGroup.findFirst.mockResolvedValue({
      id: 7,
      archive: 0,
      settingsId: 42,
    });
    prisma.template.findFirst.mockResolvedValue({
      tempId: 20,
      tempSubject: "Subject",
      tempDesc: "Body",
      groupSignatureId: 1,
      aiPrompt: null,
    });

    const { service, domainRotationService } = buildService(prisma);
    // No pool configured for this sequence yet - an expected, ongoing state,
    // not an error - so DomainRotationService resolves null.
    domainRotationService.getActiveDomainForWorkingWeek.mockResolvedValue(null);

    await service.migratePendingExcelData();

    expect(prisma.userEmail.create).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const createCall = prisma.userEmail.create.mock.calls[0][0] as {
      data: { smtpSettingId: number };
    };
    expect(createCall.data.smtpSettingId).toBe(42);
  });

  it("resolves the domain once per groupId, not once per row (avoids an N+1 on a shared batch)", async () => {
    const prisma = buildPrisma();
    prisma.excelDataUpload.findMany.mockResolvedValue([
      { id: 1, name: "A", email: "a@example.com", groupId: 7, groupExcelId: 3 },
      { id: 2, name: "B", email: "b@example.com", groupId: 7, groupExcelId: 3 },
    ]);
    prisma.templateGroup.findFirst.mockResolvedValue({
      id: 7,
      archive: 0,
      settingsId: 0,
    });
    prisma.template.findFirst.mockResolvedValue({
      tempId: 20,
      tempSubject: "Subject",
      tempDesc: "Body",
      groupSignatureId: 1,
      aiPrompt: null,
    });

    const { service, domainRotationService } = buildService(prisma);
    domainRotationService.getActiveDomainForWorkingWeek.mockResolvedValue({
      id: 555,
      fromEmail: "d@example.com",
    });

    await service.migratePendingExcelData();

    expect(
      domainRotationService.getActiveDomainForWorkingWeek,
    ).toHaveBeenCalledTimes(1);
    expect(prisma.userEmail.create).toHaveBeenCalledTimes(2);
  });

  it("leaves the row locked for retry when domain resolution genuinely errors (e.g. a DB failure), without creating it", async () => {
    const prisma = buildPrisma();
    prisma.excelDataUpload.findMany.mockResolvedValue([
      {
        id: 1,
        name: "Lead",
        email: "lead@example.com",
        groupId: 7,
        groupExcelId: 3,
      },
    ]);
    prisma.templateGroup.findFirst.mockResolvedValue({ id: 7, archive: 0 });
    prisma.template.findFirst.mockResolvedValue({
      tempId: 20,
      tempSubject: "Subject",
      tempDesc: "Body",
      groupSignatureId: 1,
      aiPrompt: null,
    });

    const { service, domainRotationService } = buildService(prisma);
    domainRotationService.getActiveDomainForWorkingWeek.mockRejectedValue(
      new Error("connection lost"),
    );

    await service.migratePendingExcelData();

    expect(prisma.userEmail.create).not.toHaveBeenCalled();
    expect(prisma.excelDataUpload.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { isLock: 0 },
    });
  });
});

describe("NewEmailSendService.dispatchPendingEmails", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses the domain stored on the row over the sequence's legacy fixed settings_id", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-24T10:00:00Z"));
    const prisma = buildPrisma();
    prisma.userEmail.findMany.mockResolvedValue([
      {
        autoId: 1,
        userEmail: "lead@example.com",
        userSubject: "Hi",
        userDesc: "Body",
        followDate: new Date("2026-08-24T09:00:00Z"),
        groupExcelid: 3,
        tempGroupId: 7,
        smtpSettingId: 321,
      },
    ]);
    prisma.groupExcel.findMany.mockResolvedValue([
      { groupExcelid: 3, excelTime: "0" },
    ]);
    prisma.templateGroup.findMany.mockResolvedValue([
      { id: 7, settingsId: 999, emailLimitPerDay: 600, timezone: "UTC" },
    ]);
    prisma.setting.findUnique.mockResolvedValue(null);

    const { service, rabbitmqPublisher } = buildService(prisma);

    await service.dispatchPendingEmails();

    expect(rabbitmqPublisher.publishSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ settingsId: 321 }),
    );
  });

  it("does not publish when another run has already claimed the row (isSend:0 -> isSend:2 race)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-24T10:00:00Z"));
    const prisma = buildPrisma();
    prisma.userEmail.findMany.mockResolvedValue([
      {
        autoId: 1,
        userEmail: "lead@example.com",
        userSubject: "Hi",
        userDesc: "Body",
        followDate: new Date("2026-08-24T09:00:00Z"),
        groupExcelid: 3,
        tempGroupId: 7,
        smtpSettingId: 321,
      },
    ]);
    prisma.groupExcel.findMany.mockResolvedValue([
      { groupExcelid: 3, excelTime: "0" },
    ]);
    prisma.templateGroup.findMany.mockResolvedValue([
      { id: 7, settingsId: 999, emailLimitPerDay: 600, timezone: "UTC" },
    ]);
    prisma.setting.findUnique.mockResolvedValue(null);
    // Another instance's UPDATE ... WHERE isSend=0 already won the row.
    prisma.userEmail.updateMany.mockResolvedValue({ count: 0 });

    const { service, rabbitmqPublisher } = buildService(prisma);

    const result = await service.dispatchPendingEmails();

    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, total: 1 });
  });
});
