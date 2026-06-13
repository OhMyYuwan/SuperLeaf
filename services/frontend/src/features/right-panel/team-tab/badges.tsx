/**
 * Official badge styling. The context default style is supplied by the TeamTab
 * container after it loads the UI setting from the backend.
 */

import { createContext, useContext } from 'react'
import { Medal } from 'lucide-react'
import type { OfficialBadgeStyle } from '../../../services/backendApi'

export const OfficialBadgeStyleContext = createContext<OfficialBadgeStyle>('metal')

export function OfficialBadge({ ariaLabel, title }: { ariaLabel: string; title: string }) {
  const style = useContext(OfficialBadgeStyleContext)
  return (
    <span className={`official-badge ${style}`} aria-label={ariaLabel} title={title}>
      <Medal size={12} />
      官方
    </span>
  )
}

export function OfficialMcpBadge() {
  return <OfficialBadge ariaLabel="官方推荐 MCP" title="官方推荐 MCP" />
}

export function OfficialSkillBadge() {
  return <OfficialBadge ariaLabel="官方 Skill" title="官方 Skill" />
}
