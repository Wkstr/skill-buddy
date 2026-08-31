import { describe, expect, it } from 'vitest'
import {
  evaluateInstructionTemplateCompliance,
  parseInstructionTemplate,
} from './governance.js'
import type { InstructionDocument } from './types.js'

const raw = `---
id: baseline
name: Engineering baseline
description: Shared repository conventions
version: 1.2.0
target: AGENTS.md
---

# Rules
`

describe('instruction governance', () => {
  it('parses a bounded Markdown template', () => {
    expect(parseInstructionTemplate(raw)).toMatchObject({
      id: 'baseline',
      version: '1.2.0',
      target: 'AGENTS.md',
      content: '# Rules\n',
    })
  })

  it('rejects a target that leaves the project or uses an unknown file name', () => {
    expect(() => parseInstructionTemplate(raw.replace('AGENTS.md', '../AGENTS.md'))).toThrow('target')
    expect(() => parseInstructionTemplate(raw.replace('AGENTS.md', 'README.md'))).toThrow('target')
  })

  it('ignores global documents when evaluating project compliance', () => {
    const template = parseInstructionTemplate(raw)
    const globalDocument = {
      path: '/project/AGENTS.md',
      scope: 'user',
      contentHash: template.contentHash,
    } as InstructionDocument

    expect(evaluateInstructionTemplateCompliance('/project', template, [globalDocument]).state).toBe('missing')
  })
})
