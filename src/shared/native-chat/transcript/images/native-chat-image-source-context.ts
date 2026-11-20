import {
  agentImageSourceContext,
  agentImageSourceContexts,
  type AgentImageSourceContextRange
} from '../../input/composer/agent-image-paste'
import { agentImagePastePath } from '../../input/composer/agent-image-paste-path'
import { createMarkdownCodeSpanScanner } from '../../../markdown/markdown-code-span-scanner'
import {
  createMarkdownFenceRangeCursor,
  forEachMarkdownLine,
  getMarkdownFenceRanges
} from '../../../markdown/markdown-fence-scanner'
import { isImageRefBlock, isTextBlock, type NativeChatBlock } from '../../native-chat-types'

function displayContexts(text: string): AgentImageSourceContextRange[] {
  const contexts = [...agentImageSourceContexts(text)]
  if (!contexts.length) {
    return contexts
  }
  const fences = getMarkdownFenceRanges(text)
  const inFence = createMarkdownFenceRangeCursor(fences)
  const quoted: [number, number][] = []
  forEachMarkdownLine(text, (start, end) => {
    if (/^ {0,3}>/.test(text.slice(start, end))) {
      quoted.push([start, end])
    }
  })
  const code = createMarkdownCodeSpanScanner(text)
  const spans: [number, number][] = []
  let end = 0
  for (const match of text.matchAll(/`+/g)) {
    if (match.index >= end && !inFence(match.index)) {
      const close = code.findSpanEnd(match.index)
      if (close !== null) {
        spans.push([match.index, close])
        end = close
      }
    }
  }
  const contextInFence = createMarkdownFenceRangeCursor(fences)
  const whitespace = /\s+/y
  let span = 0
  let quote = 0
  return contexts.filter((context) => {
    while (span < spans.length && spans[span][1] <= context.start) {
      span++
    }
    while (quote < quoted.length && quoted[quote][1] <= context.start) {
      quote++
    }
    if (
      contextInFence(context.start) ||
      (quote < quoted.length && quoted[quote][0] <= context.start) ||
      (span < spans.length && spans[span][0] < context.start) ||
      text[context.start - 1] === '\\' ||
      ((text[context.start - 1] === '"' || text[context.start - 1] === "'") &&
        text[context.start - 1] === text[context.end])
    ) {
      return false
    }
    const canonical = agentImageSourceContext(context.original, context.delivered)
    if (!canonical) {
      return false
    }
    // Providers can flatten the writer's pair-separating newlines, but not respell JSON strings.
    let cursor = context.start + 1
    for (let index = 0; index < context.original.length; index++) {
      const pair = `Image source file: ${JSON.stringify(context.original[index])}; attached viewing copy: ${JSON.stringify(context.delivered[index])}`
      if (!text.startsWith(pair, cursor)) {
        return false
      }
      cursor += pair.length
      if (index < context.original.length - 1) {
        whitespace.lastIndex = cursor
        const gap = whitespace.exec(text)?.[0]
        if (!gap) {
          return false
        }
        cursor += gap.length
      }
    }
    return cursor === context.end - 1
  })
}

export function withoutAgentImageSourceContexts(blocks: NativeChatBlock[]): NativeChatBlock[] {
  const images = blocks.filter(isImageRefBlock)
  let offset = 0
  const textParts: string[] = []
  const contexts = blocks.flatMap((block, index) => {
    if (!isTextBlock(block)) {
      return []
    }
    const result = displayContexts(block.text).map((context) => ({ ...context, index, offset }))
    textParts.push(block.text)
    offset += block.text.length + 1
    return result
  })
  const text = textParts.join(' ')
  const edges = new Set<(typeof contexts)[number]>()
  const whitespace = /\s*/y
  const blank = (start: number, end: number) => {
    whitespace.lastIndex = start
    return start + (whitespace.exec(text)?.[0].length ?? 0) >= end
  }
  let cursor = 0
  for (const context of contexts) {
    if (!blank(cursor, context.offset + context.start)) {
      break
    }
    edges.add(context)
    cursor = context.offset + context.end
  }
  cursor = text.length
  for (let index = contexts.length - 1; index >= 0; index--) {
    const context = contexts[index]
    if (!blank(context.offset + context.end, cursor)) {
      break
    }
    edges.add(context)
    cursor = context.offset + context.start
  }
  const selected = new Map<number, AgentImageSourceContextRange[]>()
  const select = (context: (typeof contexts)[number]) => {
    const ranges = selected.get(context.index) ?? []
    ranges.push(context)
    selected.set(context.index, ranges)
  }
  const starts = blocks.map((block) => (isTextBlock(block) ? block.text.search(/\S/) : -1))
  if (images.length) {
    const known = new Map<string, number[]>()
    const unknown: number[] = []
    images.forEach((image, index) => {
      if (image.path) {
        const indices = known.get(image.path) ?? []
        indices.push(index)
        known.set(image.path, indices)
      } else {
        unknown.push(index)
      }
    })
    for (let index = contexts.length - 1; index >= 0; index--) {
      const context = contexts[index]
      const block = blocks[context.index]
      if (!isTextBlock(block)) {
        continue
      }
      const edge = unknown.length > 0 && edges.has(context)
      const matched: { queue: number[]; image: number }[] = []
      for (const path of context.delivered) {
        const candidates = known.get(path)
        const queue = candidates?.length ? candidates : edge ? unknown : undefined
        const image = queue?.pop()
        if (queue && image !== undefined) {
          matched.push({ queue, image })
        } else {
          break
        }
      }
      if (matched.length === context.delivered.length) {
        select(context)
      } else {
        for (let offset = matched.length - 1; offset >= 0; offset--) {
          matched[offset].queue.push(matched[offset].image)
        }
      }
    }
  } else {
    for (let index = contexts.length - 1; index >= 0; index--) {
      const context = contexts[index]
      const block = blocks[context.index]
      if (!isTextBlock(block)) {
        continue
      }
      let beforeEnd = context.start
      const previousEnd = contexts[index - 1]?.index === context.index ? contexts[index - 1].end : 0
      while (beforeEnd > previousEnd && /\s/.test(block.text[beforeEnd - 1])) {
        beforeEnd--
      }
      const prefixes = [
        context.delivered,
        context.delivered.map((path) => agentImagePastePath('claude', path)),
        context.delivered.map((path) => agentImagePastePath(undefined, path))
      ].flatMap((paths) => [paths.join(' '), paths.join('')])
      if (
        prefixes.some(
          (prefix) =>
            prefix &&
            ((block.text.endsWith(prefix, beforeEnd) &&
              (beforeEnd === prefix.length ||
                /\s/.test(block.text[beforeEnd - prefix.length - 1]))) ||
              (block.text.startsWith(prefix, starts[context.index]) &&
                /\s/.test(block.text[starts[context.index] + prefix.length])))
        )
      ) {
        select(context)
      }
    }
  }
  if (selected.size === 0) {
    return blocks
  }
  return blocks.flatMap((block, index): NativeChatBlock[] => {
    const ranges = selected.get(index)
    if (!isTextBlock(block) || !ranges) {
      return [block]
    }
    ranges.reverse()
    let text = ''
    let cursor = 0
    for (const range of ranges) {
      text += block.text.slice(cursor, range.start)
      cursor = range.end
    }
    text += block.text.slice(cursor)
    if (!block.text.slice(0, ranges[0].start).trim()) {
      text = text.trimStart()
    }
    if (ranges.at(-1)?.end === block.text.length) {
      text = text.trimEnd()
    }
    return text.trim() ? [{ ...block, text }] : []
  })
}
