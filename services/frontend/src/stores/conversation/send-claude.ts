/**
 * 把一条用户消息送给浏览器侧 Claude Local（SuperLeaf Local Agent Host）。
 *
 * Claude 分支比 Codex 简单：不区分多轮工具调用循环（runBrowserClaudeTurn 内部
 * 自己处理），但同样维护 MCP bridge（toolMode != marker-only 时启动）。失败时
 * 静默降级，bridge 状态会通过 native.agent.tool 事件更新到 streamingStats。
 */

import {
  conversationApi,
  type MessageSend,
  type Provider,
} from '../../services/backendApi'
import {
  createBrowserClaudeSession,
  runBrowserClaudeTurn,
} from '../../services/claudeBrowserClient'
import { startBrowserToolBridge } from '../../services/browserToolBridge'
import { handleMessageEvent } from './handle-message-event'
import { formatEventError } from './sse'
import { claudeToolMode, executeClaudeBrowserToolRequest } from './tool-execution'
import type { ConversationSet } from './types'

export async function sendViaBrowserClaude(args: {
  conversationId: string
  body: MessageSend
  provider: Provider
  signal: AbortSignal
  markActivity: () => void
  set: ConversationSet
}): Promise<void> {
  const prepared = await conversationApi.prepareBrowserClaude(args.conversationId, args.body)
  args.markActivity()
  handleMessageEvent(args.set, args.conversationId, {
    event: 'ylw.msg.user',
    data: prepared.user_message,
  })

  const session = await createBrowserClaudeSession({
    endpoint: prepared.endpoint,
    prepared,
    providerName: args.provider.name,
  })
  args.markActivity()
  handleMessageEvent(args.set, args.conversationId, {
    event: 'native.agent.tool',
    data: {
      name: 'claude_local_session',
      tool_kind: 'claude_local',
      failed: false,
      local_session_id: session.id,
      external_session_id: session.claude_session_id || '',
      workspace_path: session.workspace_path || prepared.workspace_path,
    },
  })

  let stopMcpBridge = () => {}
  const toolMode = claudeToolMode(prepared)
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
          executeClaudeBrowserToolRequest({
            conversationId: args.conversationId,
            runId: prepared.run_id,
            request,
            signal,
            markActivity: args.markActivity,
            set: args.set,
          }),
      })
      args.markActivity()
      handleMessageEvent(args.set, args.conversationId, {
        event: 'native.agent.tool',
        data: {
          name: 'superleaf_mcp_context',
          tool_kind: 'superleaf_mcp',
          failed: false,
        },
      })
      stopMcpBridge = bridge.stop
    } catch {
      // Claude can still answer without tools; the status chip will surface
      // MCP refresh/poll failures when the bridge itself is reachable later.
    }
  }

  let streamedContent = ''
  let lastError = ''
  let lastClaudeSessionId = session.claude_session_id || ''
  try {
    const result = await runBrowserClaudeTurn({
      endpoint: prepared.endpoint,
      sessionId: session.id,
      prepared,
      signal: args.signal,
      onActivity: args.markActivity,
      onDelta: (delta) => {
        streamedContent += delta
        handleMessageEvent(args.set, args.conversationId, {
          event: 'ylw.msg.delta',
          data: { delta },
        })
      },
    })
    lastError = result.error
    lastClaudeSessionId = result.claudeSessionId || result.session?.claude_session_id || lastClaudeSessionId
    handleMessageEvent(args.set, args.conversationId, {
      event: 'native.agent.tool',
      data: {
        name: 'claude_cli_session',
        tool_kind: 'claude_local',
        failed: Boolean(lastError),
        local_session_id: result.session?.id || session.id,
        external_session_id: lastClaudeSessionId,
        workspace_path: result.session?.workspace_path || session.workspace_path || prepared.workspace_path,
        error: lastError,
      },
    })
    const content = result.output.trim() || streamedContent.trim() || '(Claude 没有返回可见文本。)'
    if (content && !streamedContent.trim()) {
      handleMessageEvent(args.set, args.conversationId, {
        event: 'ylw.msg.delta',
        data: { delta: content },
      })
    }
    const finished = await conversationApi.finishBrowserClaude(args.conversationId, {
      run_id: prepared.run_id,
      content,
      error: lastError,
      claude_session_id: lastClaudeSessionId,
    })
    handleMessageEvent(args.set, args.conversationId, {
      event: 'ylw.msg.finished',
      data: finished,
    })
  } finally {
    stopMcpBridge()
  }
}
