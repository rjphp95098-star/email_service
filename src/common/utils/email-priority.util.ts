import { EmailStatus } from "@prisma/client";
import { EMAIL_EVENT_PRIORITY } from "../constants/email-event-priority.constant";

export function shouldUpdateStatus(
  currentStatus: string | null | undefined,
  incomingStatus: EmailStatus,
) {
  const currentPriority =
    EMAIL_EVENT_PRIORITY[currentStatus as EmailStatus] ?? -1;

  return EMAIL_EVENT_PRIORITY[incomingStatus] > currentPriority;
}
