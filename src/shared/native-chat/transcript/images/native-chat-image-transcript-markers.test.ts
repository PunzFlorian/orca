import { nativeChatMessageCopyText } from '../messages/native-chat-message-copy-text'
import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { withoutSentImagePromptMarkers } from './native-chat-sent-image-prompt-markers'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'

function userRow(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1_000,
    source: 'transcript'
  }
}

it('folds the image-source row Claude writes after its prompt into that prompt', () => {
  const rows: NativeChatMessage[] = [
    userRow('prompt', '[Image #1] why does the upload fail?'),
    userRow('source', '[Image: source: /mnt/c/Temp/orca-paste-1.jpg]'),
    { ...userRow('reply', 'Looking.'), role: 'assistant' }
  ]

  expect(normalizeImageTranscriptMessages(rows).map((row) => [row.id, row.blocks])).toEqual([
    [
      'prompt',
      [
        { type: 'image-ref', path: '/mnt/c/Temp/orca-paste-1.jpg' },
        { type: 'text', text: 'why does the upload fail?' }
      ]
    ],
    ['reply', [{ type: 'text', text: 'Looking.' }]]
  ])
})

it('keeps generated viewing-copy context out of drawn and copied words while preserving human notes', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const generated: NativeChatMessage = {
    id: 'generated',
    role: 'user',
    blocks: [
      { type: 'image-ref', path: '/temp/a.png' },
      { type: 'text', text: `Inspect this\n\n${note}` }
    ],
    timestamp: 1,
    source: 'transcript'
  }
  expect(nativeChatMessageCopyText(generated)).toBe('Inspect this')
  expect(nativeChatMessageCopyText({ ...generated, blocks: [{ type: 'text', text: note }] })).toBe(
    note
  )
  expect(generated.blocks).toHaveLength(2)
})

it.each([false, true])(
  'removes multiple fitted-drop contexts before a caption (separate blocks=%s)',
  (separate) => {
    const a = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
    const b = '[Image source file: "/repo/b.png"; attached viewing copy: "/temp/b.png"]'
    const message: NativeChatMessage = {
      id: 'drop',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      blocks: [
        { type: 'image-ref', path: '/temp/a.png' },
        { type: 'image-ref', path: '/temp/b.png' },
        ...(separate
          ? [
              { type: 'text' as const, text: a },
              { type: 'text' as const, text: `${b} Describe these` }
            ]
          : [{ type: 'text' as const, text: `${a} ${b} Describe these` }])
      ]
    }
    expect(nativeChatMessageCopyText(message)).toBe('Describe these')
  }
)

it('preserves a human source-note caption while removing only the matching generated suffix', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const message: NativeChatMessage = {
    id: 'caption',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'image-ref', path: '/temp/a.png' },
      { type: 'text', text: `${note}\n\n${note}` }
    ]
  }
  expect(nativeChatMessageCopyText(message)).toBe(note)
})

it.each([true, false])(
  'removes only a fitted image context beside an unchanged image (fitted first=%s)',
  (first) => {
    const note = '[Image source file: "/repo/big.png"; attached viewing copy: "/temp/big.png"]'
    const paths = first
      ? ['/temp/big.png', '/repo/small.png']
      : ['/repo/small.png', '/temp/big.png']
    const message: NativeChatMessage = {
      id: 'mixed',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      blocks: [
        ...paths.map((path) => ({ type: 'image-ref' as const, path })),
        { type: 'text', text: `${note} Describe these` }
      ]
    }
    expect(nativeChatMessageCopyText(message)).toBe('Describe these')
  }
)

it('preserves a human note inside a caption beside an image with no path', () => {
  const text = 'Why did it add [Image source file: "/a.png"; attached viewing copy: "/b.png"] here?'
  const message: NativeChatMessage = {
    id: 'literal',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'image-ref', url: 'data:image/png;base64,abc' },
      { type: 'text', text }
    ]
  }
  expect(nativeChatMessageCopyText(message)).toBe(text)
})

it.each([
  '[Image source file: "/temp/a.png"; attached viewing copy: "/temp/a.png"]',
  '[Image source file: "/repo/a.png"; attached viewing copy: "\\u002ftemp/a.png"]',
  '`[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]`',
  '```text\n[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]\n```',
  '\'[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]\'',
  '> [Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
])('preserves a literal note the writer cannot emit as an unquoted context: %s', (text) => {
  const message = {
    ...userRow('literal-note', text),
    blocks: [
      { type: 'image-ref' as const, path: '/temp/a.png' },
      { type: 'text' as const, text }
    ]
  }
  expect(nativeChatMessageCopyText(message)).toBe(text)
})

it('preserves the original journal body independently of a provider projection sharing its blocks', () => {
  const text = 'Why [Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"] here?'
  const provider: NativeChatMessage = {
    ...userRow('provider', text),
    blocks: [
      { type: 'image-ref', path: '/temp/a.png' },
      { type: 'text', text }
    ]
  }
  const original = {
    ...provider,
    id: 'orca:original-send',
    journalPosition: { sequence: 1, index: 0 }
  }
  expect(nativeChatMessageCopyText(provider)).toBe('Why  here?')
  expect(nativeChatMessageCopyText(original)).toBe(text)
  expect(nativeChatMessageCopyText(provider)).toBe('Why  here?')
})

it.each([
  '[Image #1] [Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"] [Image source file: "/repo/b.png"; attached viewing copy: "/temp/b.png"] Describe',
  'Describe [Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"] [Image source file: "/repo/b.png"; attached viewing copy: "/temp/b.png"] '
])('handles the full edge run for pathless images: %s', (text) => {
  const message: NativeChatMessage = {
    ...userRow('pathless-run', text),
    blocks: [{ type: 'image-ref' }, { type: 'image-ref' }, { type: 'text', text }]
  }
  expect(nativeChatMessageCopyText(message)).toBe('Describe')
})

it('does not treat text-block splitting as proof that a middle note was generated', () => {
  const message: NativeChatMessage = {
    ...userRow('split-note', ''),
    blocks: [
      { type: 'image-ref' },
      { type: 'text', text: 'Why' },
      {
        type: 'text',
        text: '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
      },
      { type: 'text', text: 'here?' }
    ]
  }
  expect(withoutSentImagePromptMarkers(message)).toEqual(message.blocks)
})

it.each([
  [
    '/temp/a.png Describe this\n\n[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]',
    '/temp/a.png Describe this'
  ],
  [
    '/temp/view\\ image.png [Image source file: "/repo/a.png"; attached viewing copy: "/temp/view image.png"]',
    '/temp/view\\ image.png'
  ]
])('handles the existing legacy path envelope: %s', (text, expected) => {
  expect(nativeChatMessageCopyText(userRow('legacy-envelope', text))).toBe(expected)
})
