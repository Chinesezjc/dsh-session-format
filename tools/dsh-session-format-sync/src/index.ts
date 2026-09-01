/**
 * Model-facing tools for keeping the standalone dsh-session-format repo in
 * sync with the deepseek-harness session-format stack: `sf_extract` copies the
 * latest package content and re-applies the standalone adaptation,
 * `sf_verify` runs the standalone gates (tsc + vitest), and `sf_sync` runs the
 * full extract → adapt → verify → commit → push loop.
 * @module dsh-session-format-sync
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { adapt, commit, defaultTarget, extract, sync, verify, type SyncOptions } from './sync.ts'

/** Services required before the tools can register. */
export const inject = ['tools']

function resolveOptions(args: Record<string, string | undefined>): SyncOptions {
  return {
    source: args.source ?? (process.env.HOME ? `${process.env.HOME}/deepseek-harness` : '/Users/zhaijincheng/deepseek-harness'),
    target: args.target ?? defaultTarget(),
  }
}

/** Register the three session-format sync tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'sf_extract',
    description: 'Copy the latest session-format package content (src, tests, READMEs) from the deepseek-harness source tree into the standalone dsh-session-format repo and re-apply the standalone adaptation layer (EventId and writeFileAtomicDurable local imports).',
    parameters: {
      source: {
        type: 'string',
        description: 'deepseek-harness checkout root. Defaults to ~/deepseek-harness.',
      },
      target: {
        type: 'string',
        description: 'standalone repo checkout root. Defaults to ~/dsh-session-format.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          copied: { type: 'array', items: { type: 'string' } },
          adapted: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `copied: ${(value.copied ?? []).join(', ')}\nadapted: ${(value.adapted ?? []).join(', ') || 'none'}`, 
      }],
    },
    async execute(args) {
      const options = resolveOptions(args as Record<string, string | undefined>)
      const copied = await extract(options)
      const adapted = await adapt(options)
      return { copied, adapted }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sf_verify',
    description: 'Run the standalone gates for the dsh-session-format repo: npm install (if needed), tsc -b, and vitest run. Reports the vitest tail.',
    parameters: {
      source: {
        type: 'string',
        description: 'deepseek-harness checkout root (unused by verify; kept for symmetry).',
      },
      target: {
        type: 'string',
        description: 'standalone repo checkout root. Defaults to ~/dsh-session-format.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tail: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.tail ?? '').slice(-400),
      }],
    },
    async execute(args) {
      const options = resolveOptions(args as Record<string, string | undefined>)
      const tail = await verify(options)
      return { tail }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sf_sync',
    description: 'Full sync of the standalone dsh-session-format repo from the deepseek-harness stack: extract, adapt, verify (tsc + vitest), commit, and push.',
    parameters: {
      source: {
        type: 'string',
        description: 'deepseek-harness checkout root. Defaults to ~/deepseek-harness.',
      },
      target: {
        type: 'string',
        description: 'standalone repo checkout root. Defaults to ~/dsh-session-format.',
      },
      message: {
        type: 'string',
        description: 'commit message. Defaults to a timestamped sync message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.report ?? '',
      }],
    },
    async execute(args) {
      const options = resolveOptions(args as Record<string, string | undefined>)
      const message = typeof args.message === 'string' && args.message !== ''
        ? args.message
        : `sync: mirror session-format from deepseek-harness stack (${new Date().toISOString()})`
      const report = await sync(options, message)
      return { report }
    },
  }))
}

export default apply
