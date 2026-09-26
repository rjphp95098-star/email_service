import { FollowupEmailSendService } from "./followup-email-send.service";

const GROUP_ID = 1;
const PARENT_AUTO_ID = 1;

interface Scenario {
  now: string; // ISO instant
  parentSmtpSettingId: number | null;
  groupSettingsId: number;
  groupDays: string;
  followDate: string; // ISO instant, the Initial Email's own follow_date
  followSteps?: number; // steps already completed on the parent (default 0)
  alreadySentSteps?: number[]; // follow_steps already recorded for this parent
}

function buildPrisma(scenario: Scenario) {
  const parent = {
    autoId: PARENT_AUTO_ID,
    userEmail: "lead@example.com",
    userName: "Lead",
    userSubject: "Hello",
    userDesc: "Original body",
    userCreatedate: new Date(scenario.followDate),
    followDate: new Date(scenario.followDate),
    followSteps: scenario.followSteps ?? 0,
    tempGroupId: GROUP_ID,
    groupExcelid: 5,
    smtpSettingId: scenario.parentSmtpSettingId,
  };

  const group = {
    id: GROUP_ID,
    timezone: "UTC",
    settingsId: scenario.groupSettingsId,
    workingDays: "1,2,3,4,5",
  };

  const step = parent.followSteps + 1;
  const template = {
    tempId: 10,
    groupId: GROUP_ID,
    groupStep: step,
    groupDays: scenario.groupDays,
    groupSignatureId: 1,
    tempSubject: "Following up",
    tempDesc: "Just checking in",
  };

  const alreadySent = (scenario.alreadySentSteps ?? []).map((followSteps) => ({
    parentId: PARENT_AUTO_ID,
    followSteps,
  }));

  const prisma = {
    setting: {
      findUnique: jest.fn().mockResolvedValue(null), // no configured limits/counters -> defaults
      upsert: jest.fn().mockResolvedValue(undefined),
    },
    userEmail: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce([parent]) // parents query
        .mockResolvedValueOnce(alreadySent), // alreadySent query
      findFirst: jest.fn().mockResolvedValue(null), // no prior follow-up thread
      create: jest.fn().mockResolvedValue({ autoId: 999 }),
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }), // step claim on the parent
      delete: jest.fn().mockResolvedValue(undefined),
    },
    templateGroup: {
      findMany: jest.fn().mockResolvedValue([group]),
    },
    template: {
      findMany: jest.fn().mockResolvedValue([template]),
    },
    groupSignature: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    groupSmtp: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  // The claim-and-create step, and the publish-failure rollback, run inside
  // $transaction - the real client hands the callback a scoped tx client,
  // but since every mocked method above is unconditional (no per-call state
  // that a real transaction's isolation would change), handing back this
  // same object stands in for it here.
  const prismaWithTransaction = {
    ...prisma,
    $transaction: jest.fn((callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    ),
  };

  return prismaWithTransaction;
}

function buildService(scenario: Scenario) {
  jest.useFakeTimers().setSystemTime(new Date(scenario.now));
  const prisma = buildPrisma(scenario);
  const rabbitmqPublisher = {
    publishSendEmail: jest.fn().mockResolvedValue(undefined),
  };
  const service = new FollowupEmailSendService(
    prisma as any,
    rabbitmqPublisher as any,
  );
  return { service, prisma, rabbitmqPublisher };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("FollowupEmailSendService domain handling", () => {
  it("Initial D1 -> Follow-up D1, even though the sequence's active/fixed domain is now D2", async () => {
    const { service, prisma, rabbitmqPublisher } = buildService({
      now: "2026-08-28T10:00:00Z", // Friday, 10:00 UTC - past the 09:00 window
      parentSmtpSettingId: 101, // D1, stored on the Initial Email
      groupSettingsId: 102, // D2 - what the sequence's current/fixed setting is
      groupDays: "4",
      followDate: "2026-08-24T09:05:00Z", // Monday - Initial sent 4 working days ago
    });

    const result = await service.dispatchPendingFollowupEmails();

    expect(result.dispatched).toBe(1);
    expect(rabbitmqPublisher.publishSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ settingsId: 101 }),
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const createCall = prisma.userEmail.create.mock.calls[0][0] as {
      data: { smtpSettingId: number | undefined };
    };
    expect(createCall.data.smtpSettingId).toBe(101);
    expect(prisma.groupSmtp.create).toHaveBeenCalledWith({
      data: { groupId: GROUP_ID, smptId: 101 },
    });
  });

  it("Initial D2 -> Follow-up D2", async () => {
    const { rabbitmqPublisher } = await (async () => {
      const built = buildService({
        now: "2026-08-28T10:00:00Z",
        parentSmtpSettingId: 202,
        groupSettingsId: 202,
        groupDays: "4",
        followDate: "2026-08-24T09:05:00Z",
      });
      await built.service.dispatchPendingFollowupEmails();
      return built;
    })();

    expect(rabbitmqPublisher.publishSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ settingsId: 202 }),
    );
  });

  it("falls back to the sequence's fixed settings_id only when the parent predates the domain column", async () => {
    const { rabbitmqPublisher } = await (async () => {
      const built = buildService({
        now: "2026-08-28T10:00:00Z",
        parentSmtpSettingId: null, // legacy row, created before this feature
        groupSettingsId: 202,
        groupDays: "4",
        followDate: "2026-08-24T09:05:00Z",
      });
      await built.service.dispatchPendingFollowupEmails();
      return built;
    })();

    expect(rabbitmqPublisher.publishSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ settingsId: 202 }),
    );
  });
});

describe("FollowupEmailSendService working-day due-date rule", () => {
  it("does not send a step-1 follow-up before 4 working days have elapsed, even if group_days is shorter", async () => {
    const { service, rabbitmqPublisher } = buildService({
      now: "2026-08-26T10:00:00Z", // Wednesday - only 2 working days after Monday
      parentSmtpSettingId: 101,
      groupSettingsId: 101,
      groupDays: "2", // admin configured only 2 days
      followDate: "2026-08-24T09:05:00Z", // Monday
    });

    const result = await service.dispatchPendingFollowupEmails();

    expect(result.dispatched).toBe(0);
    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
  });

  it("sends the step-1 follow-up once the 4-working-day floor is reached, despite the shorter configured group_days", async () => {
    const { service, rabbitmqPublisher } = buildService({
      now: "2026-08-28T10:00:00Z", // Friday - 4 working days after Monday
      parentSmtpSettingId: 101,
      groupSettingsId: 101,
      groupDays: "2",
      followDate: "2026-08-24T09:05:00Z",
    });

    const result = await service.dispatchPendingFollowupEmails();

    expect(result.dispatched).toBe(1);
    expect(rabbitmqPublisher.publishSendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("FollowupEmailSendService duplicate prevention", () => {
  it("does not re-send a follow-up step that has already been recorded (retry/reprocessing safety)", async () => {
    const { service, rabbitmqPublisher, prisma } = buildService({
      now: "2026-08-28T10:00:00Z",
      parentSmtpSettingId: 101,
      groupSettingsId: 101,
      groupDays: "4",
      followDate: "2026-08-24T09:05:00Z",
      alreadySentSteps: [1], // step 1 already went out for this parent
    });

    const result = await service.dispatchPendingFollowupEmails();

    expect(result.dispatched).toBe(0);
    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
    expect(prisma.userEmail.create).not.toHaveBeenCalled();
  });

  it("does not send when another run has already claimed this parent's step (followSteps race)", async () => {
    const { service, rabbitmqPublisher, prisma } = buildService({
      now: "2026-08-28T10:00:00Z",
      parentSmtpSettingId: 101,
      groupSettingsId: 101,
      groupDays: "4",
      followDate: "2026-08-24T09:05:00Z",
    });
    // Another run's UPDATE ... WHERE followSteps=<read value> already won -
    // the parent has moved on before this run's claim attempt.
    prisma.userEmail.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.dispatchPendingFollowupEmails();

    expect(result.dispatched).toBe(0);
    expect(rabbitmqPublisher.publishSendEmail).not.toHaveBeenCalled();
    expect(prisma.userEmail.create).not.toHaveBeenCalled();
  });
});
