/**
 * Skill management components: the local library + market panel, the npx
 * recipe form, the private SKILL.md upload form, and the edit dialog.
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Bot, Download, FileText, FolderOpen, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import type {
  Skill,
  SkillDraft,
  SkillMarketplaceEntry,
  SkillPatch,
  SkillRecipeDraft,
} from '../../../services/backendApi'
import { nativeAgentApi } from '../../../services/backendApi'
import { OfficialSkillBadge } from './badges'
import {
  customNpxCommand,
  inferSkillName,
  inferSkillNameFromSource,
  isDirectSkillSource,
  normalizeTagText,
  parseSkillAddCommand,
  recipePreviewName,
  skillLabel,
  skillMarketMatches,
  skillPatchChanged,
  skillPillLabel,
  skillPillTone,
} from './skill-utils'

export function SkillManagementPanel({
  skills,
  marketplaceSkills,
  loading,
  error,
  onRefresh,
  onCreatePrivateSkill,
  onCreateRecipeSkill,
  onInstallMarketplaceSkill,
  onUpdateMarketplaceSkill,
  onUninstallMarketplaceSkill,
  onCloneMarketplaceSkillToLocal,
  onUpdateSkill,
  onPublishSkill,
  onUnpublishSkill,
  onRemoveSkill,
}: {
  skills: Skill[]
  marketplaceSkills: SkillMarketplaceEntry[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onCreatePrivateSkill: (draft: SkillDraft) => Promise<Skill | null>
  onCreateRecipeSkill: (draft: SkillRecipeDraft) => Promise<Skill | null>
  onInstallMarketplaceSkill: (id: string) => Promise<SkillMarketplaceEntry | null>
  onUpdateMarketplaceSkill: (id: string) => Promise<SkillMarketplaceEntry | null>
  onUninstallMarketplaceSkill: (id: string) => Promise<boolean>
  onCloneMarketplaceSkillToLocal: (id: string, name: string) => Promise<Skill | null>
  onUpdateSkill: (id: string, patch: SkillPatch) => Promise<Skill | null>
  onPublishSkill: (id: string) => Promise<Skill | null>
  onUnpublishSkill: (id: string) => Promise<Skill | null>
  onRemoveSkill: (id: string) => Promise<boolean>
}) {
  const navigate = useNavigate()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showPrivateForm, setShowPrivateForm] = useState(false)
  const [showRecipeForm, setShowRecipeForm] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null)
  const [marketSearch, setMarketSearch] = useState('')
  const [pendingShareIds, setPendingShareIds] = useState<Set<string>>(new Set())
  const privateSkills = skills.filter((skill) => skill.source === 'upload')
  const marketplaceInstalled = skills.filter((skill) => skill.source === 'marketplace')
  const customRecipeSkills = skills.filter((skill) => skill.source === 'custom')
  const projectSkills = skills.filter((skill) => skill.source === 'project')
  const filteredMarketplaceSkills = marketplaceSkills.filter((entry) => skillMarketMatches(entry, marketSearch))

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    try {
      await action()
    } finally {
      setBusyId(null)
    }
  }

  const openProjectSkill = (skill: Skill) => {
    if (!skill.project_id) return
    navigate(`/projects/${skill.project_id}`)
  }

  return (
    <section className="skill-management-panel">
      <div className="tab-header-row">
        <span>Skill 管理：{skills.length} 个可用 · {projectSkills.length} 个项目 · {marketplaceInstalled.length} 个市场 · {customRecipeSkills.length} 个自定义 · {privateSkills.length} 个私有</span>
        <button className="small-btn" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} 同步市场
        </button>
      </div>
      {error && <div className="tab-error">{error}</div>}

      <section className="skill-library-section">
        <div className="skill-market-header">
          <div>
            <strong>本地 Skill 库</strong>
            <span>Agent 只能装配这里已经存在的 Skill。</span>
          </div>
          <div className="skill-market-actions">
            <button className="ghost-btn small" type="button" onClick={() => setShowRecipeForm((v) => !v)}>
              <Plus size={12} /> 自定义 npx
            </button>
            <button className="ghost-btn small" type="button" onClick={() => setShowPrivateForm((v) => !v)}>
              <Plus size={12} /> 私有 SKILL.md
            </button>
          </div>
        </div>
        {showRecipeForm && (
          <RecipeSkillForm
            onCancel={() => setShowRecipeForm(false)}
            onSave={async (draft) => {
              const created = await onCreateRecipeSkill(draft)
              if (created) setShowRecipeForm(false)
              return created
            }}
          />
        )}
        {showPrivateForm && (
          <PrivateSkillForm
            onCancel={() => setShowPrivateForm(false)}
            onSave={async (draft) => {
              const created = await onCreatePrivateSkill(draft)
              if (created) setShowPrivateForm(false)
              return created
            }}
          />
        )}
        <div className="skill-local-list">
          {skills.length === 0 && <div className="agent-empty-inline">本地还没有 Skill。</div>}
          {skills.map((skill) => (
            <div key={skill.id} className="skill-local-row">
              <div className="skill-market-copy">
                <div className="skill-market-name-row">
                  {skill.source === 'project' && skill.project_id ? (
                    <button
                      className="skill-name-button"
                      type="button"
                      title="打开对应的 Skill project"
                      onClick={() => openProjectSkill(skill)}
                    >
                      {skillLabel(skill)}
                    </button>
                  ) : skill.can_edit && skill.source !== 'marketplace' && skill.source !== 'project' ? (
                    <button className="skill-name-button" type="button" onClick={() => setEditingSkill(skill)}>
                      {skillLabel(skill)}
                    </button>
                  ) : (
                    <strong>{skillLabel(skill)}</strong>
                  )}
                  {skill.used_by_agent_count > 0 && (
                    <span
                      className="skill-usage-badge"
                      title={`有 ${skill.used_by_agent_count} 个 Agent 在使用这个 Skill`}
                    >
                      <Bot size={11} />×{skill.used_by_agent_count}
                    </span>
                  )}
                </div>
                <span>{skill.description || '无描述'}</span>
                {skill.source === 'project' && (
                  <small>项目缓存 v{skill.cache_version || 0}{skill.cache_updated_at ? ` · ${new Date(skill.cache_updated_at).toLocaleString()}` : ''}</small>
                )}
              </div>
              <div className="skill-market-actions">
                {skill.source === 'marketplace' ? (
                  <OfficialSkillBadge />
                ) : (
                  <span className={`native-pill ${skillPillTone(skill)}`}>{skillPillLabel(skill, pendingShareIds.has(skill.id))}</span>
                )}
                <button
                  className="ghost-btn small"
                  type="button"
                  title="下载 Skill"
                  disabled={busyId === skill.id}
                  onClick={() => {
                    void run(skill.id, () => nativeAgentApi.skills.download(skill.id, `${skill.name || 'skill'}.zip`))
                  }}
                >
                  <Download size={12} /> 下载
                </button>
                <button
                  className="ghost-btn small danger"
                  type="button"
                  disabled={busyId === skill.id}
                  onClick={async () => {
                    // Fetch usage on-demand so the confirm names the impacted
                    // agents. Falls back to a generic prompt if the lookup
                    // fails — better to allow delete than to block on a
                    // network error.
                    let usage: Awaited<ReturnType<typeof nativeAgentApi.skills.usage>> = []
                    try {
                      usage = await nativeAgentApi.skills.usage(skill.id)
                    } catch {
                      // ignore; treat as "no usage info"
                    }
                    const lines = [`从本地 Skill 库移除「${skillLabel(skill)}」？`]
                    if (skill.source === 'project') {
                      lines.push('')
                      lines.push('源 Skill Project 会保留；以后打开该项目并更新 Skill 缓存即可重新加载。')
                    }
                    if (usage.length > 0) {
                      lines.push('')
                      lines.push(`以下 ${usage.length} 个 Agent 正在使用，删除后这个 Skill 会从它们身上自动解绑：`)
                      for (const u of usage.slice(0, 8)) lines.push(`  · ${u.agent_name}`)
                      if (usage.length > 8) lines.push(`  · 还有 ${usage.length - 8} 个…`)
                    }
                    if (!confirm(lines.join('\n'))) return
                    void run(skill.id, () => onRemoveSkill(skill.id))
                  }}
                >
                  {skill.source === 'project' ? '移除' : '删除'}
                </button>
              </div>
            </div>
          ))}
        </div>
        <EditSkillDialog
          skill={editingSkill}
          isSharePending={editingSkill ? pendingShareIds.has(editingSkill.id) : false}
          onOpenChange={(open) => {
            if (!open) setEditingSkill(null)
          }}
          onPublish={async (skill) => {
            const updated = await onPublishSkill(skill.id)
            if (updated) {
              setPendingShareIds((prev) => {
                const next = new Set(prev)
                next.delete(skill.id)
                return next
              })
              setEditingSkill(updated)
            }
            return updated
          }}
          onUnpublish={async (skill) => {
            const updated = await onUnpublishSkill(skill.id)
            if (updated) {
              setPendingShareIds((prev) => {
                const next = new Set(prev)
                next.delete(skill.id)
                return next
              })
              setEditingSkill(updated)
            }
            return updated
          }}
          onRemove={async (skill) => {
            const removed = await onRemoveSkill(skill.id)
            if (removed) setEditingSkill(null)
            return removed
          }}
          onSave={async (skill, patch) => {
            const updated = await onUpdateSkill(skill.id, patch)
            if (updated) {
              if (skill.visibility === 'public') {
                setPendingShareIds((prev) => new Set(prev).add(skill.id))
              }
              setEditingSkill(updated)
            }
            return updated
          }}
        />
        <div className="skill-management-note">市场和自定义 npx Skill 这里只登记配方；创建或保存 Agent 时才会真正安装到该 Agent 的 .agents/skills。</div>
      </section>

      <section className="skill-market-panel">
        <div className="skill-market-header">
        <div>
          <strong>Skill Market</strong>
          <span>来自官方 catalog；安装后成为当前用户的本地 Skill。</span>
        </div>
        <button className="ghost-btn small" type="button" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
        </div>
        <label className="skill-market-search">
          <span>搜索 Skill Market</span>
          <input
            value={marketSearch}
            onChange={(event) => setMarketSearch(event.target.value)}
            placeholder="搜索作者、Skill 名、描述、标签"
          />
        </label>
        {marketplaceSkills.length === 0 ? (
          <div className="agent-empty-inline">还没有同步到 Skill 市场。</div>
        ) : filteredMarketplaceSkills.length === 0 ? (
          <div className="agent-empty-inline">没有匹配「{marketSearch.trim()}」的 Skill。</div>
        ) : (
          <div className="skill-market-list">
            {filteredMarketplaceSkills.map((entry) => {
              return (
                <div key={entry.id} className="skill-market-row">
                  <div className="skill-market-copy">
                    <strong>{entry.id}</strong>
                    <span>{entry.description}</span>
                    <small>{entry.installed ? `已在本地 Skill 库登记 v${entry.installed_version || entry.version}` : entry.install_command}</small>
                  </div>
                  <div className="skill-market-actions">
                    <OfficialSkillBadge />
                    {entry.installed && <span className="native-pill ok">本地</span>}
                    {entry.installed && entry.update_available && (
                      <button
                        className="ghost-btn small"
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => void run(entry.id, () => onUpdateMarketplaceSkill(entry.id))}
                      >
                        更新
                      </button>
                    )}
                    {entry.installed && (
                      <button
                        className="ghost-btn small"
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => {
                          const defaultName = `${entry.display_name || entry.name || entry.id}-local`
                          const name = prompt('本地 Skill 名称：', defaultName)
                          if (name === null) return
                          void run(entry.id, () => onCloneMarketplaceSkillToLocal(entry.id, name.trim() || defaultName))
                        }}
                      >
                        复制到本地
                      </button>
                    )}
                    <button
                      className="ghost-btn small"
                      type="button"
                      disabled={busyId === entry.id}
                      onClick={() => {
                        if (entry.installed) void run(entry.id, () => onUninstallMarketplaceSkill(entry.id))
                        else void run(entry.id, () => onInstallMarketplaceSkill(entry.id))
                      }}
                    >
                      {entry.installed ? '移除本地' : '安装到本地'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </section>
  )
}

function RecipeSkillForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (draft: SkillRecipeDraft) => Promise<Skill | null>
}) {
  const [npxCommand, setNpxCommand] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [skillName, setSkillName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [tagText, setTagText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    const command = npxCommand.trim()
    const parsed = command ? parseSkillAddCommand(command) : null
    const source = sourceUrl.trim() || parsed?.source || ''
    const name = skillName.trim() || parsed?.skillName || ''
    if (!source) {
      setError('请填写 npx skills add 指令，或 GitHub Skill 文件夹 URL / npx 支持的 package')
      return
    }
    if (!isDirectSkillSource(source) && !name) {
      setError('repo/package 模式需要填写 skill name；直接 GitHub Skill 文件夹 URL 可以留空')
      return
    }
    setSaving(true)
    const created = await onSave({
      name: displayName.trim() || name || inferSkillNameFromSource(source),
      description: description.trim(),
      repo_url: source,
      source_url: source,
      skill_name: name,
      install_command: command || customNpxCommand(source, name),
      tags: normalizeTagText(tagText),
    })
    if (!created) setError('保存失败，请检查上方错误提示')
    setSaving(false)
  }

  return (
    <form className="native-agent-inline-form" onSubmit={handleSubmit}>
      <label className="full">
        <span>npx 指令</span>
        <input
          value={npxCommand}
          onChange={(event) => setNpxCommand(event.target.value)}
          placeholder="npx skills add https://github.com/vercel-labs/skills --skill find-skills"
        />
      </label>
      <label className="full">
        <span>npx 来源</span>
        <input
          value={sourceUrl}
          onChange={(event) => setSourceUrl(event.target.value)}
          placeholder="https://github.com/owner/repo/tree/main/skills/author@skill"
        />
      </label>
      <div className="form-row">
        <label>
          <span>Skill name</span>
          <input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="repo/package 模式才需要" />
        </label>
        <label>
          <span>显示名称</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="默认从来源推断" />
        </label>
      </div>
      <label className="full">
        <span>描述</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label className="full">
        <span>标签</span>
        <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="review, latex" />
      </label>
      {(sourceUrl.trim() || npxCommand.trim()) && (
        <div className="skill-folder-summary">
          <strong>{recipePreviewName(sourceUrl.trim(), skillName.trim(), npxCommand.trim())}</strong>
          <span>{customNpxCommand(sourceUrl.trim() || parseSkillAddCommand(npxCommand.trim())?.source || '', skillName.trim() || parseSkillAddCommand(npxCommand.trim())?.skillName || '')}</span>
        </div>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-btn" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : '保存配方'}
        </button>
      </div>
    </form>
  )
}

function PrivateSkillForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void
  onSave: (draft: SkillDraft) => Promise<Skill | null>
}) {
  const [draft, setDraft] = useState<SkillDraft>({
    name: '',
    folder_name: '',
    entry_filename: '',
    description: '',
    content: '',
    tags: [],
  })
  const [tagText, setTagText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDirectoryChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const files = Array.from(event.target.files ?? [])
    const entry = files.find((file) => {
      const parts = file.webkitRelativePath.split('/')
      return parts.length === 2 && parts[1] === 'SKILL.md'
    })
    if (!entry) {
      setDraft((prev) => ({ ...prev, name: '', folder_name: '', entry_filename: '', content: '' }))
      setError('请选择根目录包含精确命名 SKILL.md 的 Skill 文件夹')
      return
    }
    const folderName = entry.webkitRelativePath.split('/')[0] ?? ''
    const content = await entry.text()
    setDraft((prev) => ({
      ...prev,
      name: folderName,
      folder_name: folderName,
      entry_filename: 'SKILL.md',
      content,
    }))
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setError(null)
    const file = event.target.files?.[0]
    if (!file) return
    if (file.name !== 'SKILL.md') {
      setDraft((prev) => ({ ...prev, name: '', folder_name: '', entry_filename: '', content: '' }))
      setError('单文件上传时文件名必须精确为 SKILL.md')
      return
    }
    const content = await file.text()
    const inferredName = inferSkillName(content)
    setDraft((prev) => ({
      ...prev,
      name: inferredName,
      folder_name: '',
      entry_filename: 'SKILL.md',
      content,
    }))
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    const skillName = (draft.folder_name || draft.name || inferSkillName(draft.content)).trim()
    if (!skillName || draft.entry_filename !== 'SKILL.md' || !draft.content.trim()) {
      setError('请选择包含根目录 SKILL.md 的文件夹，或直接选择 SKILL.md 文件')
      return
    }
    setSaving(true)
    const created = await onSave({
      ...draft,
      name: skillName,
      folder_name: draft.folder_name?.trim() ?? '',
      entry_filename: 'SKILL.md',
      description: draft.description?.trim() ?? '',
      content: draft.content.trim(),
      tags: tagText.split(',').map((tag) => tag.trim()).filter(Boolean),
    })
    if (!created) setError('保存失败，请检查上方错误提示')
    setSaving(false)
  }

  return (
    <form className="native-agent-inline-form" onSubmit={handleSubmit}>
      <div className="skill-upload-picker-row">
        <label className="skill-upload-picker">
          <input
            type="file"
            {...{ webkitdirectory: '', directory: '' }}
            onChange={handleDirectoryChange}
          />
          <span className="skill-upload-button">
            <FolderOpen size={13} /> 选择文件夹
          </span>
          <small>根目录需包含 SKILL.md</small>
        </label>
        <label className="skill-upload-picker">
          <input type="file" accept=".md,text/markdown,text/plain" onChange={handleFileChange} />
          <span className="skill-upload-button">
            <FileText size={13} /> 选择 SKILL.md
          </span>
          <small>仅上传单个 SKILL.md</small>
        </label>
      </div>
      <div className="form-row">
        <label>
          <span>标签</span>
          <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="review, latex" />
        </label>
      </div>
      {draft.folder_name && (
        <div className="skill-folder-summary">
          <strong>{draft.folder_name}</strong>
          <span>已读取根目录 SKILL.md；后端会保存为 GitHub用户名@{draft.folder_name}</span>
        </div>
      )}
      {!draft.folder_name && draft.content && (
        <div className="skill-folder-summary">
          <strong>{draft.name || 'SKILL'}</strong>
          <span>已读取单文件 SKILL.md；后端会用 GitHub用户名@技能名 作为逻辑文件夹包裹。</span>
        </div>
      )}
      <label className="full">
        <span>描述</span>
        <input value={draft.description ?? ''} onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))} />
      </label>
      <textarea value={draft.content} readOnly rows={5} placeholder="选择 Skill 文件夹后显示 SKILL.md 内容预览。" />
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button type="button" className="ghost-btn" onClick={onCancel} disabled={saving}>取消</button>
        <button type="submit" className="primary-btn" disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : '保存 Skill'}
        </button>
      </div>
    </form>
  )
}

function EditSkillDialog({
  skill,
  isSharePending,
  onOpenChange,
  onSave,
  onPublish,
  onUnpublish,
  onRemove,
}: {
  skill: Skill | null
  isSharePending: boolean
  onOpenChange: (open: boolean) => void
  onSave: (skill: Skill, patch: SkillPatch) => Promise<Skill | null>
  onPublish: (skill: Skill) => Promise<Skill | null>
  onUnpublish: (skill: Skill) => Promise<Skill | null>
  onRemove: (skill: Skill) => Promise<boolean>
}) {
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [tagText, setTagText] = useState('')
  const [shareScope, setShareScope] = useState<'private' | 'server'>('private')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentPatch = (): SkillPatch => ({
    description: description.trim(),
    content: content.trim(),
    tags: normalizeTagText(tagText),
  })

  const isDirty = Boolean(skill && skillPatchChanged(skill, currentPatch()))
  const canShare = Boolean(skill && skill.visibility === 'private' && shareScope === 'server')
  const canUpdateShared = Boolean(skill && skill.visibility === 'public' && shareScope === 'server' && (isDirty || isSharePending))
  const canUnshare = Boolean(skill && skill.visibility === 'public')

  useEffect(() => {
    if (!skill) return
    setDescription(skill.description)
    setContent(skill.content)
    setTagText((skill.tags ?? []).join(', '))
    setShareScope(skill.visibility === 'public' ? 'server' : 'private')
    setError(null)
  }, [skill])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!skill) return
    setError(null)
    if (!content.trim()) {
      setError('SKILL.md 内容不能为空')
      return
    }
    setSaving(true)
    await onSave(skill, currentPatch())
    setSaving(false)
  }

  const handlePublish = async () => {
    if (!skill) return
    if (shareScope !== 'server') return
    if (skill.visibility === 'private' && !confirm('共享后，当前服务器上的其他可见用户可装配此 Skill；这不会提交到 Skill Market。继续共享？')) return
    if (skill.visibility === 'public' && !canUpdateShared) return
    setSaving(true)
    let publishTarget = skill
    if (isDirty) {
      const updated = await onSave(skill, currentPatch())
      if (updated) publishTarget = updated
    }
    await onPublish(publishTarget)
    setSaving(false)
  }

  const handleUnpublish = async () => {
    if (!skill) return
    if (!canUnshare) return
    setSaving(true)
    await onUnpublish(skill)
    setSaving(false)
  }

  const handleRemove = async () => {
    if (!skill) return
    if (!confirm(`删除 Skill「${skillLabel(skill)}」？`)) return
    setSaving(true)
    await onRemove(skill)
    setSaving(false)
  }

  return (
    <Dialog.Root open={Boolean(skill)} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="skill-dialog-overlay" />
        <Dialog.Content className="skill-dialog-content">
          <div className="skill-dialog-header">
            <div>
              <Dialog.Title className="skill-dialog-title">{skill ? skillLabel(skill) : '修改 Skill'}</Dialog.Title>
              <p>修改会更新当前服务器上的这份 Skill 内容。</p>
            </div>
            <Dialog.Close asChild>
              <button className="icon-btn" aria-label="关闭"><X size={18} /></button>
            </Dialog.Close>
          </div>
          {skill && (
            <form className="skill-dialog-form" onSubmit={handleSubmit}>
              <label>
                <span>描述</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} />
              </label>
              <label>
                <span>标签</span>
                <input value={tagText} onChange={(event) => setTagText(event.target.value)} />
              </label>
              <div className="skill-share-row">
                <label>
                  <span>共享范围</span>
                  <select value={shareScope} onChange={(event) => setShareScope(event.target.value as 'private' | 'server')} disabled={saving}>
                    <option value="private">私有</option>
                    <option disabled>项目（后续）</option>
                    <option disabled>合作者（后续）</option>
                    <option value="server">服务器</option>
                    <option disabled>Market（后续）</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handlePublish}
                  disabled={saving || (skill.visibility === 'public' ? !canUpdateShared : !canShare)}
                >
                  {skill.visibility === 'public' ? '更新' : '共享'}
                </button>
                <button type="button" className="ghost-btn" onClick={handleUnpublish} disabled={saving || !canUnshare}>
                  取消共享
                </button>
              </div>
              <label>
                <span>SKILL.md</span>
                <textarea className="skill-md-textarea" value={content} onChange={(event) => setContent(event.target.value)} rows={12} />
              </label>
              {error && <div className="form-error">{error}</div>}
              <div className="form-actions">
                <button type="button" className="danger-btn" onClick={handleRemove} disabled={saving}>
                  删除
                </button>
                <button type="button" className="ghost-btn" onClick={() => onOpenChange(false)} disabled={saving}>取消</button>
                <button type="submit" className="primary-btn" disabled={saving}>
                  {saving ? <Loader2 size={14} className="spin" /> : '保存修改'}
                </button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
