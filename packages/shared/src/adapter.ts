import type { DeliveryResult, RenderedNotification } from "./types.js";

export interface NotificationAdapter {
  send(payload: RenderedNotification): Promise<DeliveryResult>;
}
