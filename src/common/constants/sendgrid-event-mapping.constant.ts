import { EmailStatus } from "@prisma/client";

export const SENDGRID_EVENT_STATUS_MAP = {
  processed: EmailStatus.PROCESSED,

  delivered: EmailStatus.DELIVERED,

  open: EmailStatus.OPENED,

  click: EmailStatus.CLICKED,

  bounce: EmailStatus.BOUNCED,

  dropped: EmailStatus.DROPPED,
};
