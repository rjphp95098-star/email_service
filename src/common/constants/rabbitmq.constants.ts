export const QUEUES = {
  EMAIL: "email_queue",

  EMAIL_DLQ: "email_dead_letter_queue",

  NOTIFICATION: "notification_queue",

  INITIAL_EMAIL_SEQUENCE: "initial_email_queue",

  INITIAL_EMAIL_DLQ: "initial_email_dead_letter_queue",

  FOLLOWUP_EMAIL_SEQUENCE: "followup_email_queue",

  FOLLOWUP_EMAIL_DLQ: "followup_email_dead_letter_queue",
} as const;

export const buildSequenceQueueNames = (sequenceId: number) => {
  const initialQueue = `${QUEUES.INITIAL_EMAIL_SEQUENCE}_${sequenceId}`;
  const followupQueue = `${QUEUES.FOLLOWUP_EMAIL_SEQUENCE}_${sequenceId}`;

  return {
    initialQueue,
    initialDlq: `${initialQueue}_dead_letter_queue`,
    followupQueue,
    followupDlq: `${followupQueue}_dead_letter_queue`,
  };
};

export const EVENTS = {
  SEND_EMAIL: "SEND_EMAIL",
  EMAIL_SENT: "EMAIL_SENT",
  EMAIL_FAILED: "EMAIL_FAILED",
  FIRE_INITIAL_EMAIL: "FIRE_INITIAL_EMAIL",
  FIRE_FOLLOWUP_EMAIL: "FIRE_FOLLOWUP_EMAIL",
} as const;
