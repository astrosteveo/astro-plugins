import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { STYLE, instructions } from '../hooks/register'

const BODY = '# Writing style\n\nLead with the answer.'
const FILE = `---\nname: Plain English\nforce-for-plugin: true\n---\n\n${BODY}\n`

type Setup = {
  // The style file's text, or null when the plugin folder has none.
  file?: string | null
  // What the hooks beneath this plugin hand the subagent.
  context?: string[]
}

// An engine whose plugin folder holds the style file and whose other hooks answer `context`.
function engine(on: On, { file = FILE, context }: Setup = {}) {
  on('fs.read', (_, e) => {
    if (file === null || !String(e.path).endsWith(`/${STYLE}`)) throw new Error('ENOENT')
    return { value: file }
  })
  on('classic.SubagentStart', () => (context === undefined ? {} : { additionalContext: context }))
}

for (const type of ['general-purpose', 'Explore', 'Plan', 'bug-hunt:hunter']) {
  test(`${type} subagent gets the style's instructions as context`, async ($, on) => {
    engine(on)
    const result = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: type })
    expect(result.additionalContext).toEqual([BODY])
  })
}

test('a fork gets nothing added, since it inherits the main system prompt and its style', async ($, on) => {
  engine(on)
  const result = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'fork' })
  expect(result.additionalContext ?? []).toEqual([])
})

test("another hook's context stays, with the style after it", async ($, on) => {
  engine(on, { context: ['Use uv.'] })
  const result = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
  expect(result.additionalContext).toEqual(['Use uv.', BODY])
})

test('when the style file is missing, the subagent starts with what it had', async ($, on) => {
  engine(on, { file: null, context: ['Use uv.'] })
  const result = await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'general-purpose' })
  expect(result.additionalContext).toEqual(['Use uv.'])
})

test('instructions drop the frontmatter, with Windows line endings too', async () => {
  expect(instructions(FILE)).toBe(BODY)
  expect(instructions(FILE.replaceAll('\n', '\r\n'))).toBe(BODY.replaceAll('\n', '\r\n'))
  expect(instructions(`${BODY}\n`)).toBe(BODY)
})
