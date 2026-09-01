import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Stable identity of one session event; never changes across compaction or
 * reordering. Extracted from the deepseek-harness session spine so this
 * standalone package owns its core identity type.
 */
export type EventId = Branded<'EventId'>

/**
 * Brand a string as an {@link EventId}.
 * @param id - the raw event id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function EventId(id: string): EventId {
  return id as EventId
}
