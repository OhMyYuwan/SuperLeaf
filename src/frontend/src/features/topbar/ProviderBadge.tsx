/**
 * ProviderBadge — tiny status chip for the active LLM/Dify provider.
 *
 * Tones:
 *   err  — backend offline or provider returns errors
 *   warn — no provider configured yet
 *   ok   — provider probed successfully
 *   idle — provider saved but not yet verified
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
    label = '未配置 Provider'
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
