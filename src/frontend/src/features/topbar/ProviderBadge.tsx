/**
 * ProviderBadge — tiny status chip for the active Agent team.
 *
 * Tones:
 *   err  — backend offline or connection errors
 *   warn — no agent configured yet
 *   ok   — agent team ready
 *   idle — agent saved but not yet verified
 */

interface ProviderBadgeProps {
  reachable: boolean | null
  providerName: string | null
  providerStatus: string | null
  onOpen: () => void
}

export function ProviderBadge({
  reachable,
  providerName,
  providerStatus,
  onOpen,
}: ProviderBadgeProps) {
  let label: string
  let tone: 'idle' | 'ok' | 'warn' | 'err'
  if (reachable === false) {
    label = '后端离线'
    tone = 'err'
  } else if (!providerName) {
    label = '未配置 Agent'
    tone = 'warn'
  } else if (providerStatus === 'error') {
    label = `${providerName} · 连接失败`
    tone = 'err'
  } else if (providerStatus === 'ok') {
    label = providerName
    tone = 'ok'
  } else {
    label = `${providerName} · 未验证`
    tone = 'idle'
  }
  return (
    <button className={`provider-badge ${tone}`} onClick={onOpen} title="打开设置">
      <span className="dot" />
      {label}
    </button>
  )
}
