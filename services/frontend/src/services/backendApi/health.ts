/**
 * 后端健康检查 API。
 */

import { http } from './client'

export const healthApi = {
  check: () => http<{ status: string; service: string }>('/api/health'),
}

// LaTeX compilation
