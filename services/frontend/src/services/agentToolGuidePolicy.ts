import type { NanobotToolDefinition } from './backendApi'
import { formatCompactSuperleafToolGuide } from './superleafTools'

export type SuperLeafToolGuideMode = 'schema-only' | 'marker-fallback'
export type SuperLeafToolTransportMode = 'mcp-first' | 'browser-preflight' | 'marker-only' | 'native-tool-calls'

export function toolGuideModeForTransport(
  transport: SuperLeafToolTransportMode,
  nativeToolsAvailable = true,
): SuperLeafToolGuideMode {
  if (transport === 'marker-only' || !nativeToolsAvailable) return 'marker-fallback'
  return 'schema-only'
}

export function toolGuideModeForNanobot(): SuperLeafToolGuideMode {
  return 'marker-fallback'
}

export function shouldIncludeSuperleafToolGuide(mode: SuperLeafToolGuideMode): boolean {
  return mode === 'marker-fallback'
}

export function buildSuperleafFallbackToolGuide(tools: NanobotToolDefinition[]): string {
  return formatCompactSuperleafToolGuide(tools)
}
