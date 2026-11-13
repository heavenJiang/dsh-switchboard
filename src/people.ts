/**
 * What each person may do. Everyone on a line's allow-list is an admin until
 * the Members page says otherwise; members and guests are kept to their
 * directories and their permission preset.
 */

import { resolve, sep } from 'node:path'

/** How much a person may do. */
export type Role = 'admin' | 'member' | 'guest'

/** One person's settings, as configured. */
export interface PersonSettings {
  /** Line id. */
  readonly line: string
  /** User id as the line's allow-list names it. */
  readonly id: string
  readonly role: Role
  /** Permission preset of the Sessions they create; members only (guests are read-only). */
  readonly preset?: string
  /** Directories they may work in; empty keeps them to the default working directory. */
  readonly dirs?: readonly string[]
}

/** A person as the bridge applies their rights. */
export interface Actor {
  readonly role: Role
  /** Preset for new Sessions; undefined uses the plugin-wide one. */
  readonly preset?: string
  /** Directories they may use; undefined means anywhere. */
  readonly dirs?: readonly string[]
  /** In a group, the line telling the Agent who is speaking. */
  readonly speaker?: string
}

export const ADMIN: Actor = { role: 'admin' }

const GUEST_PRESET = 'read-only'
const MEMBER_PRESET = 'workspace-write'

/** Harness commands only admins run: they change what the Agent may do. */
const ADMIN_COMMANDS = /permission|sandbox|approv|trust|mode|yolo/iu

/**
 * Who someone is on a line.
 * @param ids - their id, aliases, and `@username`, any of which the record may name.
 * @param viaChat - they are admitted only because their chat is allowed, not by name.
 * @param fallbackDir - the working directory a member without directories is kept to.
 */
export function actorFor(
  people: readonly PersonSettings[] | undefined, line: string, ids: readonly string[], viaChat: boolean, fallbackDir: string | undefined,
): Actor {
  const wanted = new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '').map(id => id.trim().toLowerCase()))
  const record = people?.find(person => person.line === line && wanted.has(person.id.trim().toLowerCase()))
  const role: Role = record?.role ?? (viaChat ? 'member' : 'admin')
  if (role === 'admin') return ADMIN
  const configured = (record?.dirs ?? []).map(dir => dir.trim()).filter(dir => dir !== '')
  const dirs = configured.length > 0 ? configured : fallbackDir === undefined ? [] : [fallbackDir]
  return {
    role,
    preset: role === 'guest' ? GUEST_PRESET : (record?.preset?.trim() || MEMBER_PRESET),
    dirs,
  }
}

/** Characters of a display name a speaker line keeps. */
const SPEAKER_NAME_LENGTH = 40

/**
 * The line that tells the Agent who said a group message. Names are chosen by
 * their owners, so the role comes first and a name cannot close the bracket,
 * start a new line, or pass for a field.
 * @param name - display name.
 * @param username - platform handle, when there is one.
 */
export function speakerLine(role: Role, name: string, username?: string): string {
  const clean = (text: string): string => text.replace(/[\p{C}\p{Zl}\p{Zp}[\]|]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, SPEAKER_NAME_LENGTH)
  const handle = username === undefined ? '' : ` @${clean(username)}`
  return `[group chat | role: ${role} | from: ${clean(name) || 'unknown'}${handle}]`
}

/** Whether a path lies inside one of an actor's directories (anywhere for admins). */
export function mayUse(actor: Actor, path: string | undefined): boolean {
  if (actor.dirs === undefined) return true
  if (path === undefined) return false
  const target = resolve(path)
  return actor.dirs.some((dir) => {
    const root = resolve(dir)
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  })
}

/** Whether an actor may run a Harness slash command. */
export function mayRunCommand(actor: Actor, name: string): boolean {
  if (actor.role === 'admin') return true
  if (actor.role === 'guest') return false
  return !ADMIN_COMMANDS.test(name)
}
