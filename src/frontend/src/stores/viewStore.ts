/**
 * viewStore — UI 视图控制状态管理
 *
 * 管理各个面板的显示/隐藏状态，支持用户自定义工作区布局。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ViewState {
  // 面板可见性
  leftPanel: boolean
  editorColumn: boolean
  previewColumn: boolean
  annotationColumn: boolean
  rightPanel: boolean

  // 切换方法
  toggleLeftPanel: () => void
  toggleEditorColumn: () => void
  togglePreviewColumn: () => void
  toggleAnnotationColumn: () => void
  toggleRightPanel: () => void

  // 批量设置
  setVisibility: (panels: Partial<Omit<ViewState, 'toggleLeftPanel' | 'toggleEditorColumn' | 'togglePreviewColumn' | 'toggleAnnotationColumn' | 'toggleRightPanel' | 'setVisibility'>>) => void
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      // 默认全部显示
      leftPanel: true,
      editorColumn: true,
      previewColumn: true,
      annotationColumn: true,
      rightPanel: true,

      toggleLeftPanel: () => set((s) => ({ leftPanel: !s.leftPanel })),
      toggleEditorColumn: () => set((s) => ({ editorColumn: !s.editorColumn })),
      togglePreviewColumn: () => set((s) => ({ previewColumn: !s.previewColumn })),
      toggleAnnotationColumn: () => set((s) => ({ annotationColumn: !s.annotationColumn })),
      toggleRightPanel: () => set((s) => ({ rightPanel: !s.rightPanel })),

      setVisibility: (panels) => set(panels),
    }),
    {
      name: 'yuwan-view-state-v1',
    },
  ),
)
