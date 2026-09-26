import { createHmac } from "node:crypto";
import { EmailStatusGateway } from "./email-status.gateway";

const SECRET = "test-secret";

function buildGateway() {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === "INTERNAL_SERVICE_SECRET") return SECRET;
      throw new Error(`unexpected config key ${key}`);
    }),
  };

  const gateway = new EmailStatusGateway(configService as any);

  const to = jest.fn();
  const emit = jest.fn();
  to.mockReturnValue({ emit });
  gateway.server = { to } as unknown as EmailStatusGateway["server"];

  const client = { join: jest.fn() };

  return { gateway, to, emit, client };
}

function tokenForRoom(room: string): string {
  return createHmac("sha256", SECRET).update(room).digest("hex");
}

function tokenFor(tempGroupId: number, groupExcelid: number): string {
  return tokenForRoom(`batch:${tempGroupId}:${groupExcelid}`);
}

const SAMPLE_PAYLOAD = {
  autoId: 10,
  tempGroupId: 5,
  groupExcelid: 12,
  emailStatus: "DELIVERED",
  emailCount: 0,
  errordetails: "",
  isSend: 1,
  unsubscribe: 0,
};

describe("EmailStatusGateway.notifyRowChanged", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("emits 'batch-changed' with the payload (wrapped in an array) to both the batch room and its sequence room, after the coalescing delay", () => {
    const { gateway, to, emit } = buildGateway();

    gateway.notifyRowChanged(SAMPLE_PAYLOAD);

    expect(emit).not.toHaveBeenCalled();

    jest.runAllTimers();

    expect(to).toHaveBeenCalledWith("batch:5:12");
    expect(to).toHaveBeenCalledWith("sequence:5");
    expect(emit).toHaveBeenCalledWith("batch-changed", [SAMPLE_PAYLOAD]);
  });

  it("coalesces multiple calls for the same room into a single emit", () => {
    const { gateway, to, emit } = buildGateway();
    const second = { ...SAMPLE_PAYLOAD, autoId: 11 };

    gateway.notifyRowChanged(SAMPLE_PAYLOAD);
    gateway.notifyRowChanged(second);

    jest.runAllTimers();

    const batchEmitCalls = (emit.mock.calls as [string, unknown][]).filter(
      (call) => call[0] === "batch-changed",
    );

    // One flush per distinct room (batch:5:12 and sequence:5), each
    // carrying both payloads - not one emit per notifyRowChanged() call.
    expect(to).toHaveBeenCalledTimes(2);
    expect(batchEmitCalls).toHaveLength(2);
    expect(batchEmitCalls[0][1]).toEqual([SAMPLE_PAYLOAD, second]);
  });

  it("does not emit to a different batch's room", () => {
    const { gateway, to } = buildGateway();

    gateway.notifyRowChanged(SAMPLE_PAYLOAD);
    jest.runAllTimers();

    expect(to).not.toHaveBeenCalledWith("batch:5:99");
    expect(to).not.toHaveBeenCalledWith("batch:99:12");
    expect(to).not.toHaveBeenCalledWith("sequence:99");
  });
});

describe("EmailStatusGateway.notifyBatchGenerationChanged", () => {
  it("emits 'batch-generation-changed' to the sequence room immediately, uncoalesced", () => {
    const { gateway, to, emit } = buildGateway();

    gateway.notifyBatchGenerationChanged({
      tempGroupId: 5,
      groupExcelid: 12,
      statusKey: "completed",
    });

    expect(to).toHaveBeenCalledWith("sequence:5");
    expect(to).not.toHaveBeenCalledWith("batch:5:12");
    expect(emit).toHaveBeenCalledWith("batch-generation-changed", {
      tempGroupId: 5,
      groupExcelid: 12,
      statusKey: "completed",
    });
  });
});

describe("EmailStatusGateway.onJoinBatch", () => {
  it("joins the client to the correct room given a valid token", () => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinBatch(client as any, {
      tempGroupId: 5,
      groupExcelid: 12,
      token: tokenFor(5, 12),
    });

    expect(client.join).toHaveBeenCalledWith("batch:5:12");
    expect(result).toEqual({ ok: true });
  });

  it("rejects an invalid token without joining", () => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinBatch(client as any, {
      tempGroupId: 5,
      groupExcelid: 12,
      token: tokenFor(5, 99),
    });

    expect(client.join).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });

  it("rejects a token minted for a different room", () => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinBatch(client as any, {
      tempGroupId: 5,
      groupExcelid: 12,
      token: tokenFor(6, 12),
    });

    expect(client.join).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });

  it.each([
    [{ groupExcelid: 12, token: "abc" }],
    [{ tempGroupId: 5, token: "abc" }],
    [{ tempGroupId: 5, groupExcelid: 12 }],
    [{ tempGroupId: "5", groupExcelid: 12, token: "abc" }],
    [{ tempGroupId: 5, groupExcelid: 12, token: "" }],
    [null],
    [undefined],
    ["not-an-object"],
  ])("rejects malformed payload %p without joining", (payload) => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinBatch(client as any, payload);

    expect(client.join).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });
});

describe("EmailStatusGateway.onJoinSequence", () => {
  it("joins the client to the correct sequence room given a valid token", () => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinSequence(client as any, {
      tempGroupId: 5,
      token: tokenForRoom("sequence:5"),
    });

    expect(client.join).toHaveBeenCalledWith("sequence:5");
    expect(result).toEqual({ ok: true });
  });

  it("rejects a batch-room token reused for a sequence join", () => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinSequence(client as any, {
      tempGroupId: 5,
      token: tokenFor(5, 12),
    });

    expect(client.join).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });

  it.each([
    [{ token: "abc" }],
    [{ tempGroupId: 5 }],
    [{ tempGroupId: "5", token: "abc" }],
    [{ tempGroupId: 5, token: "" }],
    [null],
    [undefined],
  ])("rejects malformed payload %p without joining", (payload) => {
    const { gateway, client } = buildGateway();

    const result = gateway.onJoinSequence(client as any, payload);

    expect(client.join).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });
});
