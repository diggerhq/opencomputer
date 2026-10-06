import { z } from 'zod'

export const managedAgentEventSchema = z.object({
  id: z.string().optional(),
  seq: z.number(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  turnId: z.string().optional(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
})

export type ManagedAgentEvent = z.infer<typeof managedAgentEventSchema>
