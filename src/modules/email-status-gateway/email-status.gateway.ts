import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const roomArray = new Set<Socket>();

function isAllowedOrigin(origin: string | undefined): boolean {
  return !!origin && ALLOWED_ORIGINS.has(origin);
}

// batch:<tempGroupId>:<groupExcelid> - one upload/batch's rows (batch_emails.php,
// recipient_followups.php). sequence:<tempGroupId> - every batch under that
// sequence at once (ai-sequence-details.php's New Emails/Follow-ups tabs,
// which query across all batches, not one). A batch-level change always
// also matters to its sequence-level room - see notifyBatchChanged().
function batchRoom(tempGroupId: number, groupExcelid: number): string {
  return `batch:${tempGroupId}:${groupExcelid}`;
}

function sequenceRoom(tempGroupId: number): string {
  return `sequence:${tempGroupId}`;
}

interface JoinBatchPayload {
  tempGroupId: number;
  groupExcelid: number;
  token: string;
}

interface JoinSequencePayload {
  tempGroupId: number;
  token: string;
}

// Fields the frontend needs to patch an already-rendered row in place - see
// resolveRowStatusFromRaw()/patchFollowupRow() in ai-sequence.js, which port
// tracking_project's status-label logic to build the same badge/opens cells
// this used to require a follow-up AJAX call to get. previousEmailStatus is
// only set on the status-priority write path (used for the Overview tab's
// delivered/pending delta) - omitted elsewhere.
export interface BatchGenerationChangedPayload {
  tempGroupId: number;
  groupExcelid: number;
  statusKey: string;
}

export interface RowChangedPayload {
  autoId: number;
  tempGroupId: number;
  groupExcelid: number;
  emailStatus: string | null;
  previousEmailStatus?: string | null;
  emailCount: number;
  errordetails: string;
  isSend: number;
  unsubscribe: number;
}

function isValidJoinBatchPayload(data: unknown): data is JoinBatchPayload {
  if (!data || typeof data !== "object") {
    return false;
  }

  const payload = data as Record<string, unknown>;

  return (
    Number.isFinite(payload.tempGroupId) &&
    Number.isFinite(payload.groupExcelid) &&
    typeof payload.token === "string" &&
    payload.token.length > 0
  );
}

function isValidJoinSequencePayload(
  data: unknown,
): data is JoinSequencePayload {
  if (!data || typeof data !== "object") {
    return false;
  }

  const payload = data as Record<string, unknown>;

  return (
    Number.isFinite(payload.tempGroupId) &&
    typeof payload.token === "string" &&
    payload.token.length > 0
  );
}

@Injectable()
@WebSocketGateway({
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  },
})
export class EmailStatusGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(EmailStatusGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly configService: ConfigService) {}

  // Socket.io fires this on any connection loss (client close, network
  // drop, transport timeout) - without it, roomArray keeps piling up dead
  // sockets forever since join-batch/join-sequence only ever add to it.
  handleDisconnect(client: Socket): void {
    roomArray.delete(client);
    this.logger.warn(`socket disconnected: ${client.id}`);
  }

  private expectedToken(room: string): Buffer {
    const secret = this.configService.getOrThrow<string>(
      "INTERNAL_SERVICE_SECRET",
    );

    return createHmac("sha256", secret).update(room).digest();
  }

  private isTokenValid(room: string, token: string): boolean {
    const expected = this.expectedToken(room);
    const provided = Buffer.from(token, "hex");

    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }

  @SubscribeMessage("join-batch")
  onJoinBatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): { ok: boolean } {
    if (!isValidJoinBatchPayload(data)) {
      this.logger.warn(`Rejected join-batch: malformed payload`);
      return { ok: false };
    }

    const room = batchRoom(data.tempGroupId, data.groupExcelid);

    if (!this.isTokenValid(room, data.token)) {
      this.logger.warn(`Rejected join-batch: invalid token for ${room}`);
      return { ok: false };
    }

    void client.join(room);

    roomArray.add(client);

    this.logger.warn(`join-batch: token for ${room}`);

    return { ok: true };
  }

  @SubscribeMessage("join-sequence")
  onJoinSequence(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): { ok: boolean } {
    if (!isValidJoinSequencePayload(data)) {
      this.logger.warn(`Rejected join-sequence: malformed payload`);
      return { ok: false };
    }

    const room = sequenceRoom(data.tempGroupId);

    if (!this.isTokenValid(room, data.token)) {
      this.logger.warn(`Rejected join-sequence: invalid token for ${room}`);
      return { ok: false };
    }

    void client.join(room);

    roomArray.add(client);

    return { ok: true };
  }

  // Coalesces same-room emits within a short window instead of one socket
  // frame per row - a burst of a batch's own initial send (webhooks arrive
  // for many rows within milliseconds of each other) would otherwise flood
  // every connected client with hundreds of individual frames.
  private static readonly FLUSH_DELAY_MS = 200;
  private readonly pendingByRoom = new Map<string, RowChangedPayload[]>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  private queueForRoom(room: string, payload: RowChangedPayload): void {
    const pending = this.pendingByRoom.get(room) ?? [];
    pending.push(payload);
    this.pendingByRoom.set(room, pending);

    if (!this.flushTimers.has(room)) {
      const timer = setTimeout(
        () => this.flushRoom(room),
        EmailStatusGateway.FLUSH_DELAY_MS,
      );
      this.flushTimers.set(room, timer);
    }
  }

  private flushRoom(room: string): void {
    const payloads = this.pendingByRoom.get(room);
    this.flushTimers.delete(room);
    this.pendingByRoom.delete(room);
    for (const client of roomArray) {
       if (client.rooms.has(room)) {
        client.emit("batch-changed", payloads);
      }
    }

    // if (payloads && payloads.length > 0) {
    //   this.server.to(room).emit("batch-changed", payloads);
    // }
  }

  notifyRowChanged(payload: RowChangedPayload): void {
    this.queueForRoom(
      batchRoom(payload.tempGroupId, payload.groupExcelid),
      payload,
    );
    this.queueForRoom(sequenceRoom(payload.tempGroupId), payload);
  }

  // One event per batch's whole generation run (not per-recipient like
  // notifyRowChanged), so there's no burst to coalesce - emitted straight
  // away. Only the sequence room matters here: the Overview tab that shows
  // this status is sequence-wide, same as the New Emails/Follow-ups tabs.
  notifyBatchGenerationChanged(payload: BatchGenerationChangedPayload): void {
    this.server
      .to(sequenceRoom(payload.tempGroupId))
      .emit("batch-generation-changed", payload);
  }
}
