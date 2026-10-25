export const STATUS_LABEL = { active: 'Active', banned: 'Banned', inactive: 'Inactive', deleted: 'Deleted' } as const
export const EVENT_LABEL = {
  signup: 'Created account',
  login: 'Logged in',
  logout: 'Logged out',
  deleted: 'Deleted account',
  restored: 'Restored account',
} as const
export const EVENT_ICON = { signup: 'plus', login: 'user', logout: 'logout', deleted: 'trash', restored: 'undo' } as const
