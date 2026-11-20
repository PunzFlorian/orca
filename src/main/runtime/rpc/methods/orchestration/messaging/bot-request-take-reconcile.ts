/** An agent question is owed its asker an answer or one notice. The chat that took it decides it at
 *  its first rest after the take: answered by then, or the asker is told once, whatever made the chat
 *  stop. One decision for every edge (a turn end of any outcome, a stop, a closed or deleted chat,
 *  a usage-limit continue given up, a dismissed restart, Orca starting): each only asks for it. */

import type { BotRequestRow } from '../../../../orchestration/db/bot-requests/bot-request-store'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotRequestUnansweredWhy } from '../../../../../bots/bot-request-view'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionQuestionRest } from '../../../../../native-chat/agent-session-wire/observations/structured-agent-session-turn-completion-feed'
import { ensureSenderRecords, tellSender } from './bot-request-outcome'

type QuestionRestReader = {
  readQuestionRest: (sessionId: string) => Promise<StructuredAgentSessionQuestionRest | null>
  /** Chats cut by a restart whose Continue still waits on a person. */
  offeredCuts: () => Promise<ReadonlyMap<string, unknown>>
}

// One decision per chat at a time; an edge during it asks for one more after.
const deciding = new Map<string, { again: boolean; done: Promise<void> }>()
// The chat's words for its last failed request, for the notice.
const failureReasons = new Map<string, string>()

/** A chat's request failed: its notice, if one is owed, says why. */
export function noteBotRequestFailureReason(sessionId: string, reason: string | undefined): void {
  if (reason) {
    failureReasons.set(sessionId, reason)
  } else {
    failureReasons.delete(sessionId)
  }
}

/** Decides the questions a chat took, now that something about its rest may have changed. */
export function reconcileBotRequestTakes(
  runtime: OrcaRuntimeService,
  sessionId: string,
  reader: QuestionRestReader | null = hostRestReader()
): Promise<void> {
  const current = deciding.get(sessionId)
  if (current) {
    current.again = true
    return current.done
  }
  const entry = { again: false, done: Promise.resolve() }
  entry.done = (async () => {
    try {
      do {
        entry.again = false
        await decide(runtime, sessionId, reader)
      } while (entry.again)
    } catch (error) {
      console.warn('[orchestration] deciding agent questions a chat took failed', sessionId, error)
    } finally {
      deciding.delete(sessionId)
    }
  })()
  deciding.set(sessionId, entry)
  return entry.done
}

/** Once per start, after restored chats settled: every chat still holding an undecided question. */
export async function reconcileBotRequestTakesAtStartup(
  runtime: OrcaRuntimeService,
  reader: QuestionRestReader | null = hostRestReader()
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  await Promise.all(
    db
      .listSessionsWithOpenBotRequestTakes()
      .map((sessionId) => reconcileBotRequestTakes(runtime, sessionId, reader))
  )
}

async function decide(
  runtime: OrcaRuntimeService,
  sessionId: string,
  reader: QuestionRestReader | null
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  // Read before any wait: a request a later turn takes is never decided by this read.
  const takes = db.listOpenBotRequestTakes(sessionId)
  if (takes.length === 0) {
    return
  }
  // A person who deleted it unread released it, whatever the chat does.
  const due: { take: BotRequestRow; why: BotRequestUnansweredWhy }[] = takes
    .filter((take) => take.taken_by === 'person')
    .map((take) => ({ take, why: 'withdrawn' }))
  const read = takes.filter((take) => take.taken_by !== 'person')
  const why = read.length > 0 && reader ? await restWhy(reader, sessionId) : null
  if (why) {
    due.push(...read.map((take) => ({ take, why })))
  }
  if (due.length === 0) {
    return
  }
  const messages = due.map(({ take }) => db.getMessageById(take.message_id))
  await ensureSenderRecords(runtime, messages)
  const reason = failureReasons.get(sessionId)
  due.forEach(({ why }, index) => {
    const message = messages[index]
    if (message) {
      tellSender(runtime, db, message, {
        outcome: why === 'withdrawn' ? 'dropped' : 'unanswered',
        why,
        ...(why === 'failed' && reason ? { reason } : {}),
        takenBy: sessionId,
        once: true
      })
    }
  })
}

/** Why the chat stopped without answering; null while it may still answer (a turn running or owed,
 *  live work, a continue Orca will send, or a restart Continue a person has yet to decide). */
async function restWhy(
  reader: QuestionRestReader,
  sessionId: string
): Promise<BotRequestUnansweredWhy | null> {
  const rest = await reader.readQuestionRest(sessionId)
  if (!rest || rest.kind === 'busy' || rest.kind === 'continuing') {
    return null
  }
  if ((await reader.offeredCuts()).has(sessionId)) {
    return null
  }
  if (rest.kind === 'closed') {
    return 'ended'
  }
  return rest.outcome === 'failure'
    ? 'failed'
    : rest.outcome === 'cancellation'
      ? 'stopped'
      : 'ended'
}

function hostRestReader(): QuestionRestReader | null {
  const host = getStructuredAgentSessionHost()
  return host
    ? {
        readQuestionRest: (sessionId) => host.reads.questionRest(sessionId),
        offeredCuts: () => host.restartResume.offeredCuts()
      }
    : null
}
