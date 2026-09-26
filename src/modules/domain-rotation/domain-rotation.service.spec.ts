import { DomainRotationService } from "./domain-rotation.service";

function makePrisma() {
  return {
    templateGroup: { findUnique: jest.fn() },
    sequenceSmtpSetting: { findMany: jest.fn() },
    smtpSetting: { findFirst: jest.fn() },
  };
}

describe("DomainRotationService.getActiveDomainForWorkingWeek", () => {
  const startDate = new Date("2026-08-24T00:00:00Z"); // Monday, week 1
  const timezone = "UTC";

  // Insertion order (id ascending, as the mocked findMany already returns
  // them) is the rotation order - the table has no separate order column.
  const pool = [
    { smtpSettingId: 101 }, // D1 - added first
    { smtpSettingId: 102 }, // D2 - added second
    { smtpSettingId: 103 }, // D3 - added third
  ];

  function setup(now: Date) {
    const prisma = makePrisma();
    prisma.templateGroup.findUnique.mockResolvedValue({
      startDate,
      timezone,
    });
    prisma.sequenceSmtpSetting.findMany.mockResolvedValue(pool);
    prisma.smtpSetting.findFirst.mockImplementation(
      ({ where }: { where: { id: number } }) =>
        Promise.resolve({ id: where.id, fromEmail: `d${where.id}@x.com` }),
    );

    jest.useFakeTimers().setSystemTime(now);
    const service = new DomainRotationService(prisma as any);
    return { service, prisma };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it("week 1 (sequence's own start week) uses the first domain in the pool", async () => {
    const { service } = setup(new Date("2026-08-25T10:00:00Z")); // Tuesday, week 1
    const domain = await service.getActiveDomainForWorkingWeek(1);
    expect(domain?.id).toBe(101);
  });

  it("week 2 uses the second domain in the pool", async () => {
    const { service } = setup(new Date("2026-08-31T10:00:00Z")); // Monday, week 2
    const domain = await service.getActiveDomainForWorkingWeek(1);
    expect(domain?.id).toBe(102);
  });

  it("week 3 uses the third domain in the pool", async () => {
    const { service } = setup(new Date("2026-09-07T10:00:00Z")); // Monday, week 3
    const domain = await service.getActiveDomainForWorkingWeek(1);
    expect(domain?.id).toBe(103);
  });

  it("week 4 wraps back around to the first domain", async () => {
    const { service } = setup(new Date("2026-09-14T10:00:00Z")); // Monday, week 4
    const domain = await service.getActiveDomainForWorkingWeek(1);
    expect(domain?.id).toBe(101);
  });

  it("returns null (not a throw) when the sequence has no domain pool configured yet", async () => {
    const { service, prisma } = setup(new Date("2026-08-25T10:00:00Z"));
    prisma.sequenceSmtpSetting.findMany.mockResolvedValue([]);

    const domain = await service.getActiveDomainForWorkingWeek(1);
    expect(domain).toBeNull();
  });

  it("returns null (not a throw) when the pool's smtp setting has been deleted", async () => {
    const { service, prisma } = setup(new Date("2026-08-25T10:00:00Z"));
    prisma.smtpSetting.findFirst.mockResolvedValue(null);

    const domain = await service.getActiveDomainForWorkingWeek(1);
    expect(domain).toBeNull();
  });

  it("throws when the template group does not exist", async () => {
    const { service, prisma } = setup(new Date("2026-08-25T10:00:00Z"));
    prisma.templateGroup.findUnique.mockResolvedValue(null);

    await expect(service.getActiveDomainForWorkingWeek(999)).rejects.toThrow(
      /no template group/,
    );
  });
});
