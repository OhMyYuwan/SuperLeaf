/**
 * 把一条用户消息送给浏览器侧 Codex Local（SuperLeaf Local Agent Host），
 * 处理 MCP bridge + 多轮工具调用，最终落库为 agent 消息。
 *
 * 对比 Nanobot 分支多出来的复杂度：
 * - **MCP bridge**：当 toolMode 不是 marker-only 时，启动 BrowserToolBridge，
 *   把 SuperLeaf 工具桥到 Codex；失败时静默降级到 marker / preflight
 * - **delta context**：用 codexDeltaContextSnapshots 缓存发送过的 context，
 *   下一轮强制标记为 unchanged，节省网络往返
 * - **long-running reminder**：codex_long_running_reminder 事件挂到
 *   streamingStats.waitingReminder 上提示用户「Agent 还在思考，可手动停止」
 * - **tool round 上限**：8 轮后强制 break，避免无限循环
 */

import {
  conversationApi,
  type BrowserCodexPrepare,
  type MessageSend,
  type Provider,
} from '../../services/backendApi'
import {
  createBrowserCodexSession,
  codexToolMode,
  runBrowserCodexTurn,
  type BrowserCodexSession,
} from '../../services/codexBrowserClient'
import { startBrowserToolBridge } from '../../services/browserToolBridge'
import { shouldIncludeCodexSessionBoot } from '../../services/agentPromptPolicy'
import {
  applyCodexDeltaContext,
  forceCodexDeltaContextUnchanged,
  type CodexDeltaContextSnapshot,
} from '../../services/superleafDeltaContextPolicy'
import { handleMessageEvent } from './handle-message-event'
import { inferBrowserNanobotPreflightToolCalls } from './preflight-inference'
import { formatEventError, objectRecord } from './sse'
import { executeCodexBrowserToolRequest, executeCodexToolCall } from './tool-execution'
import type { ConversationSet } from './types'

const codexDeltaContextSnapshots = new Map<string, CodexDeltaContextSnapshot>()

function codexDeltaContextKey(
  session: BrowserCodexSession,
  prepared: BrowserCodexPrepare,
): string {
  const conversationId = String(prepared.superleaf_context.conversation_id ?? '')
  return [
    'codex-local',
    session.id || session.codex_session_id || conversationId,
    prepared.provider_id,
    conversationId,
  ].filter(Boolean).join(':')
}

export async function sendViaBrowserCodex(args: {
  conversationId: string
  body: MessageSend
  provider: Provider
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<void> {
  let prepared = await conversationApi.prepareBrowserCodex(args.conversationId, args.body)
  args.markActivity()
  handleMessageEvent(args.set, args.conversationId, {
    event: 'ylw.msg.user',
    data: prepared.user_message,
  })

  const session = await createBrowserCodexSession({
    endpoint: prepared.endpoint,
    prepared,
    providerName: args.provider.name,
  })
  args.markActivity()
  handleMessageEvent(args.set, args.conversationId, {
    event: 'native.agent.tool',
    data: {
      name: 'codex_local_session',
      tool_kind: 'codex_local',
      failed: false,
      local_session_id: session.id,
      external_session_id: session.codex_session_id || '',
      workspace_path: session.workspace_path || prepared.workspace_path,
    },
  })

  const deltaContextKey = codexDeltaContextKey(session, prepared)
  const deltaContext = applyCodexDeltaContext(
    prepared,
    codexDeltaContextSnapshots.get(deltaContextKey),
  )
  prepared = deltaContext.prepared

  const toolResults: Awaited<ReturnType<typeof conversationApi.executeBrowserCodexTool>>[] = []
  const finalParts: string[] = []
  let lastError = ''
  let lastCodexSessionId = session.codex_session_id || ''
  let stopMcpBridge = () => {}
  let mcpContextId = ''
  const toolMode = codexToolMode(prepared)
  const includeSessionBoot = shouldIncludeCodexSessionBoot(prepared, session)
  const preflightToolCalls = toolMode === 'browser-preflight'
    ? inferBrowserNanobotPreflightToolCalls(args.body.content, prepared)
    : []

  if (toolMode !== 'marker-only') {
    try {
      const bridge = await startBrowserToolBridge({
        endpoint: prepared.endpoint,
        context: {
          projectId: String(prepared.superleaf_context.project_id ?? ''),
          conversationId: String(prepared.superleaf_context.conversation_id ?? ''),
          documentId: prepared.document_id,
          rangeStart: prepared.range_start,
          rangeEnd: prepared.range_end,
          inputs: prepared.inputs,
          contextMode: String(prepared.codex_settings?.context_mode || prepared.codex_settings?.codex_context_mode || ''),
          promptPolicy: objectRecord(prepared.superleaf_context.prompt_policy),
          providerId: prepared.provider_id,
          providerName: String(prepared.superleaf_context.provider_name ?? ''),
          documentName: String(prepared.superleaf_context.document_name ?? ''),
          documentFormat: String(prepared.superleaf_context.document_format ?? ''),
          selectionHash: String(prepared.superleaf_context.selection_hash ?? ''),
          selectionPreview: String(prepared.superleaf_context.selection_preview ?? ''),
          docVersion: String(prepared.superleaf_context.doc_version ?? ''),
          toolSurface: 'codex-local',
          toolManifestVersion: String(prepared.superleaf_context.tool_manifest_version ?? ''),
          contextChanged: String(prepared.superleaf_context.context_changed ?? ''),
          accessMode: prepared.codex_settings?.sandbox === 'read-only' ? 'read-only' : 'full',
        },
        parentSignal: args.signal,
        onActivity: args.markActivity,
        onPollError: (err) => {
          handleMessageEvent(args.set, args.conversationId, {
            event: 'native.agent.tool',
            data: {
              name: 'superleaf_mcp_poll',
              tool_kind: 'superleaf_mcp',
              failed: true,
              error: formatEventError(err),
            },
          })
        },
        onRefreshError: (err) => {
          handleMessageEvent(args.set, args.conversationId, {
            event: 'native.agent.tool',
            data: {
              name: 'superleaf_mcp_refresh',
              tool_kind: 'superleaf_mcp',
              failed: true,
              error: formatEventError(err),
            },
          })
        },
        onRequestError: (request, err) => {
          handleMessageEvent(args.set, args.conversationId, {
            event: 'native.agent.tool',
            data: {
              name: request.name,
              tool_kind: 'superleaf_mcp',
              failed: true,
              error: formatEventError(err),
            },
          })
        },
        executeRequest: async (request, signal) =>
          executeCodexBrowserToolRequest({
            conversationId: args.conversationId,
            runId: prepared.run_id,
            request,
            signal,
            markActivity: args.markActivity,
            set: args.set,
          }),
      })
      args.markActivity()
      mcpContextId = bridge.context.context_id
      handleMessageEvent(args.set, args.conversationId, {
        event: 'native.agent.tool',
        data: {
          name: 'superleaf_mcp_context',
          tool_kind: 'superleaf_mcp',
          failed: false,
          context_id: mcpContextId,
        },
      })
      stopMcpBridge = bridge.stop
    } catch {
      // Keep marker/preflight fallback if the downloaded Local Host is old or
      // the MCP context endpoint is temporarily absent.
    }
  }

  for (const toolCall of preflightToolCalls) {
    const result = await executeCodexToolCall({
      conversationId: args.conversationId,
      runId: prepared.run_id,
      prepared,
      toolCall,
      signal: args.signal,
      markActivity: args.markActivity,
      set: args.set,
    })
    toolResults.push(result)
  }

  const maxToolRounds = 8
  try {
    for (let round = 0; round < maxToolRounds; round += 1) {
      let streamedRoundContent = ''
      const roundPrepared = round === 0
        ? prepared
        : forceCodexDeltaContextUnchanged(prepared)
      const result = await runBrowserCodexTurn({
        endpoint: roundPrepared.endpoint,
        sessionId: session.id,
        session,
        prepared: roundPrepared,
        contextId: mcpContextId,
        toolResults,
        includeSessionBoot: round === 0 && includeSessionBoot,
        signal: args.signal,
        onActivity: args.markActivity,
        onDelta: (delta) => {
          streamedRoundContent += delta
          handleMessageEvent(args.set, args.conversationId, {
            event: 'ylw.msg.delta',
            data: { delta },
          })
        },
        onEvent: (event) => {
          if (String(event.method || '') !== 'superleaf/codex_long_running_reminder') return
          const message = String(event.message || 'Codex 仍在长时间推理，可手动停止。')
          args.set((s) => {
            const current = s.streamingStats[args.conversationId] ?? {
              filesRead: 0,
              filesWritten: 0,
            }
            return {
              streamingStats: {
                ...s.streamingStats,
                [args.conversationId]: {
                  ...current,
                  waitingReminder: message,
                },
              },
            }
          })
        },
      })
      if (round === 0) {
        codexDeltaContextSnapshots.set(deltaContextKey, deltaContext.snapshot)
      }
      lastError = result.error
      lastCodexSessionId = result.codexSessionId || result.session?.codex_session_id || lastCodexSessionId
      handleMessageEvent(args.set, args.conversationId, {
        event: 'native.agent.tool',
        data: {
          name: 'codex_cli_session',
          tool_kind: 'codex_local',
          failed: Boolean(lastError),
          local_session_id: result.session?.id || session.id,
          external_session_id: lastCodexSessionId,
          workspace_path: result.session?.workspace_path || session.workspace_path || prepared.workspace_path,
          error: lastError,
        },
      })

      if (result.toolCalls.length > 0) {
        args.set((s) => ({
          streamingDelta: { ...s.streamingDelta, [args.conversationId]: '' },
        }))
      }

      if (result.toolCalls.length === 0) {
        const content = result.output.trim() || finalParts.join('').trim() || '(Codex 没有返回可见文本。)'
        if (content && !streamedRoundContent.trim()) {
          handleMessageEvent(args.set, args.conversationId, {
            event: 'ylw.msg.delta',
            data: { delta: content },
          })
        }
        const finished = await conversationApi.finishBrowserCodex(args.conversationId, {
          run_id: prepared.run_id,
          content,
          error: lastError,
          codex_session_id: lastCodexSessionId,
        })
        handleMessageEvent(args.set, args.conversationId, {
          event: 'ylw.msg.finished',
          data: finished,
        })
        return
      }

      if (result.output.trim()) {
        finalParts.push(result.output.trim())
      }
      for (const toolCall of result.toolCalls) {
        const toolResult = await executeCodexToolCall({
          conversationId: args.conversationId,
          runId: prepared.run_id,
          prepared,
          toolCall,
          signal: args.signal,
          markActivity: args.markActivity,
          set: args.set,
        })
        toolResults.push(toolResult)
      }
    }

    throw new Error('Codex 工具调用轮次过多，已停止以避免无限循环')
  } finally {
    stopMcpBridge()
  }
}
