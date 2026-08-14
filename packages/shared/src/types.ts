export type NotificationChannel = "email" | "webhook" | "push";

export type NotificationStatus = "queued" | "delivering" | "delivered" | "failed" | "dead";

export type DeliveryStatus = "succeeded" | "failed";

export interface NotificationRequest {
  channel: NotificationChannel;
  to: string;
  template: string;
  templateVersion?: number;
  data?: Record<string, unknown>;
}

export interface RenderedNotification {
  channel: NotificationChannel;
  to: string;
  subject?: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface DeliveryResult {
  status: DeliveryStatus;
  error?: string;
}
