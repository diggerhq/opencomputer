import type { ChatMinimapPayload } from "../types/chat-minimap";

export const isChatMinimapPayload = (
  value: unknown
): value is ChatMinimapPayload =>
  typeof value === "object" && value !== null && "title" in value;
