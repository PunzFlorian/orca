import { expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { withoutSentImagePromptMarkers } from './native-chat-sent-image-prompt-markers'

it.each([10, 100])('bounds cold context projection and reuses it for %i notes', (count) => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const text = ' '.repeat(count * 64) + Array.from({ length: count }, () => note).join(' ')
  const message: NativeChatMessage = {
    id: 'provider-contexts',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      ...Array.from({ length: count }, () => ({ type: 'image-ref' as const, path: '/temp/a.png' })),
      { type: 'text', text }
    ]
  }
  let copiedCharacters = 0
  let movedSlots = 0
  const slice = String.prototype.slice
  const unshift = Array.prototype.unshift
  const sliceSpy = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
    this: string,
    start,
    end
  ) {
    const result = slice.call(this, start, end)
    copiedCharacters += result.length
    return result
  })
  const unshiftSpy = vi.spyOn(Array.prototype, 'unshift').mockImplementation(function (
    this: unknown[],
    ...items
  ) {
    movedSlots += this.length
    return unshift.apply(this, items)
  })
  try {
    const result = withoutSentImagePromptMarkers(message)
    const coldWork = copiedCharacters + movedSlots * 8
    expect(result.filter((block) => block.type === 'text')).toEqual([])
    expect(coldWork).toBeLessThanOrEqual(text.length * 16)
    expect(withoutSentImagePromptMarkers(message)).toBe(result)
    expect(copiedCharacters + movedSlots * 8).toBe(coldWork)
  } finally {
    sliceSpy.mockRestore()
    unshiftSpy.mockRestore()
  }
})
