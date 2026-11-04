import { tr } from '../../i18n'
export const STATUS_LABEL = { active: tr('Active'), banned: tr('Banned'), inactive: tr('Inactive'), deleted: tr('Deleted') } as const
export const EVENT_LABEL = {
  signup: tr('Created account'),
  login: tr('Logged in'),
  logout: tr('Logged out'),
  deleted: tr('Deleted account'),
  restored: tr('Restored account'),
  password: tr('Reset password'),
} as const
export const EVENT_ICON = { signup: 'plus', login: 'user', logout: 'logout', deleted: 'trash', restored: 'undo', password: 'lock' } as const
