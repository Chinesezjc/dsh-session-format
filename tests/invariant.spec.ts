import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionFormatInvariant from '../src/invariant.ts'

describe('session-format invariant companion', () => {
  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionFormatInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-session-format', () => {})
    }).toThrow(/already registered/)
  })

  it('releases the package reservation when the companion is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SessionFormatInvariant)

    await fiber.dispose()

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-session-format', () => {})
    }).not.toThrow()
  })
})
