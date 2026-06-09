import { http } from './backendApi'
import type { User } from './authApi'

export interface UserUpdateBody {
  is_disabled?: boolean
  is_admin?: boolean
  display_name?: string
}

export interface RegistrationInvite {
  id: string
  email: string
  token_hint: string
  created_by_user_id: string
  created_at: string
  expires_at: string | null
  used_at: string | null
  used_by_user_id: string | null
  revoked_at: string | null
  send_status: string
  send_error: string
  last_sent_at: string | null
  note: string
}

export interface RegistrationInviteCreateBody {
  email?: string
  expires_in_days?: number
  note?: string
  send_email?: boolean
}

export interface RegistrationInviteIssue extends RegistrationInvite {
  token: string
  invite_url: string
  smtp_configured: boolean
}

export interface RegistrationInviteEmailStatus {
  smtp_configured: boolean
  from_email: string
}

export const adminApi = {
  listUsers: () => http<User[]>('/api/users', { scope: 'global' }),

  updateUser: (userId: string, body: UserUpdateBody) =>
    http<User>(`/api/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      scope: 'global',
    }),

  deleteUser: (userId: string) =>
    http<void>(`/api/users/${userId}`, {
      method: 'DELETE',
      scope: 'global',
    }),

  emailStatus: () =>
    http<RegistrationInviteEmailStatus>('/api/users/invites/email-status', { scope: 'global' }),

  listInvites: () =>
    http<RegistrationInvite[]>('/api/users/invites', { scope: 'global' }),

  createInvite: (body: RegistrationInviteCreateBody) =>
    http<RegistrationInviteIssue>('/api/users/invites', {
      method: 'POST',
      body: JSON.stringify(body),
      scope: 'global',
    }),

  revokeInvite: (inviteId: string) =>
    http<RegistrationInvite>(`/api/users/invites/${inviteId}`, {
      method: 'DELETE',
      scope: 'global',
    }),

  resendInvite: (inviteId: string) =>
    http<RegistrationInviteIssue>(`/api/users/invites/${inviteId}/resend`, {
      method: 'POST',
      scope: 'global',
    }),
}
