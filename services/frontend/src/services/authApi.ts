/**
 * authApi — register / login / logout / me.
 *
 * All endpoints are `scope: 'global'` so the `X-Project-Id` header isn't
 * required (the user has no current project on the login screen).
 */

import { http } from './backendApi'

export interface User {
  id: string
  email: string
  display_name: string
  is_admin: boolean
  is_disabled: boolean
  created_at: string
  last_login_at: string | null
}

export interface LoginBody {
  email: string
  password: string
}

export interface RegisterBody {
  email: string
  password: string
  display_name?: string
  bootstrap_token?: string
  invite_token?: string
}

export const authApi = {
  me: () => http<User>('/api/auth/me', { scope: 'global' }),

  login: (body: LoginBody) =>
    http<User>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(body),
      scope: 'global',
    }),

  register: (body: RegisterBody) =>
    http<User>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
      scope: 'global',
    }),

  logout: () =>
    http<void>('/api/auth/logout', { method: 'POST', scope: 'global' }),
}
