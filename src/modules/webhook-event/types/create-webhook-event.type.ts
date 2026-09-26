export interface CreateWebhookEventData {
  userEmailId: number | null;

  eventType: string;

  eventTimestamp: Date;

  webhookPayload: Record<string, any>;

  // SendGrid's own sg_event_id, used as the row's guid so a retried webhook
  // delivery (same event, sent again) can be told apart from a real repeat
  // event - falls back to a random guid when SendGrid didn't send one.
  guid?: string;
}
