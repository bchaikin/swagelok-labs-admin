import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError, type Actor, type AdminUser, type Site } from '../lib/api.ts'
import { Button, Card, Chip, Modal, Notice, Spinner, Toggle, fmtDate, statusLabel, statusTone } from '../components/ui.tsx'

type Props = { me: Actor; sites: Site[]; adminGroup: string; onChanged: () => void }

export default function UsersPage({ me, sites, adminGroup, onChanged }: Props) {
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // username currently being changed
  const [showInvite, setShowInvite] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const load = () => api.users().then(setUsers).catch((e: Error) => setError(e.message))
  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 4000)
    return () => clearTimeout(t)
  }, [flash])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!users) return []
    if (!needle) return users
    return users.filter((u) => [u.email, u.name, u.username, u.status, ...u.groups].some((s) => s.toLowerCase().includes(needle)))
  }, [users, q])

  const replace = (u: AdminUser) => setUsers((list) => (list ?? []).map((x) => (x.username === u.username ? u : x)))

  const run = async (username: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(username)
    setError(null)
    try {
      const u = await fn()
      if (u && typeof u === 'object' && 'username' in u) replace(u as AdminUser)
      setFlash(done)
      onChanged()
    } catch (e) {
      setError((e as ApiError).message)
    } finally {
      setBusy(null)
      setMenuFor(null)
    }
  }

  const isSelf = (u: AdminUser) => u.username === me.username || u.email.toLowerCase() === me.email.toLowerCase()

  const toggleGroup = (u: AdminUser, group: string, on: boolean) => {
    const next = on ? [...new Set([...u.groups, group])] : u.groups.filter((g) => g !== group)
    void run(u.username, () => api.setGroups(u.username, next), `${on ? 'Granted' : 'Removed'} ${labelFor(group)} for ${u.email}`)
  }
  const labelFor = (group: string) => (group === adminGroup ? 'admin' : sites.find((s) => s.group === group)?.name ?? group)

  const confirmThen = (message: string, username: string, fn: () => Promise<unknown>, done: string) => {
    if (window.confirm(message)) void run(username, fn, done)
    else setMenuFor(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-ink">Users</h1>
          <p className="text-sm text-ink-soft">Everyone in the shared sign-in pool. Toggle which sites each person can open.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, status…"
            className="w-64 rounded-lg border border-line px-3 py-2 text-sm outline-none ring-brand/30 focus:border-brand focus:ring-2"
            aria-label="Search users"
          />
          <Button onClick={() => setShowInvite(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            Invite user
          </Button>
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {flash && <Notice tone="ok">{flash}</Notice>}

      {!users ? (
        <Spinner label="Loading users…" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-surface text-[11px] uppercase tracking-wide text-ink-soft">
              <tr>
                <th className="px-4 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Enabled</th>
                {sites.map((s) => (
                  <th key={s.group} className="px-3 py-2 text-center" title={s.url}>{s.name}</th>
                ))}
                <th className="px-3 py-2 text-center">Admin</th>
                <th className="px-3 py-2 text-left">Created</th>
                <th className="px-3 py-2 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {shown.map((u) => {
                const self = isSelf(u)
                const locked = busy === u.username
                return (
                  <tr key={u.username} className={`hover:bg-surface/60 ${locked ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-ink">{u.email || u.username}{self && <span className="ml-2 text-[11px] font-normal text-ink-soft">(you)</span>}</div>
                      {u.name && <div className="text-xs text-ink-soft">{u.name}</div>}
                    </td>
                    <td className="px-3 py-2.5"><Chip tone={statusTone(u.status)}>{statusLabel(u.status)}</Chip></td>
                    <td className="px-3 py-2.5">
                      <Toggle
                        checked={u.enabled}
                        disabled={locked || self}
                        label={u.enabled ? `Disable ${u.email}` : `Enable ${u.email}`}
                        onChange={(v) =>
                          v
                            ? void run(u.username, () => api.update(u.username, { enabled: true }), `Enabled ${u.email}`)
                            : confirmThen(`Disable ${u.email}? They will be signed out of every site.`, u.username, () => api.update(u.username, { enabled: false }), `Disabled ${u.email}`)
                        }
                      />
                    </td>
                    {sites.map((s) => (
                      <td key={s.group} className="px-3 py-2.5 text-center">
                        <Toggle checked={u.groups.includes(s.group)} disabled={locked} label={`${s.name} access for ${u.email}`} onChange={(v) => toggleGroup(u, s.group, v)} />
                      </td>
                    ))}
                    <td className="px-3 py-2.5 text-center">
                      <Toggle
                        checked={u.groups.includes(adminGroup)}
                        disabled={locked || (self && u.groups.includes(adminGroup))}
                        label={`Admin rights for ${u.email}`}
                        onChange={(v) => toggleGroup(u, adminGroup, v)}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-soft" title={`Updated ${fmtDate(u.updated)}`}>{fmtDate(u.created)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <ActionsMenu open={menuFor === u.username} onToggle={(open) => setMenuFor(open ? u.username : null)}>
                          {u.status === 'FORCE_CHANGE_PASSWORD' && (
                            <MenuItem onClick={() => void run(u.username, () => api.action(u.username, 'resend-invite'), `Invitation re-sent to ${u.email}`)}>Re-send invitation</MenuItem>
                          )}
                          {u.status === 'CONFIRMED' && (
                            <MenuItem onClick={() => confirmThen(`Reset password for ${u.email}? They get an email with a code and must choose a new password.`, u.username, () => api.action(u.username, 'reset-password'), `Password reset started for ${u.email}`)}>Reset password</MenuItem>
                          )}
                          <MenuItem onClick={() => confirmThen(`Reset the authenticator (MFA) for ${u.email}? They will set up a new one at next sign-in.`, u.username, () => api.action(u.username, 'reset-mfa'), `MFA reset for ${u.email}`)}>Reset MFA device</MenuItem>
                          <MenuItem onClick={() => void run(u.username, () => api.action(u.username, 'sign-out'), `Signed ${u.email} out everywhere`)}>Sign out everywhere</MenuItem>
                          {!self && (
                            <MenuItem danger onClick={() => confirmThen(`Permanently delete ${u.email}? This cannot be undone.`, u.username, async () => { await api.remove(u.username); setUsers((l) => (l ?? []).filter((x) => x.username !== u.username)) }, `Deleted ${u.email}`)}>Delete user</MenuItem>
                          )}
                      </ActionsMenu>
                    </td>
                  </tr>
                )
              })}
              {shown.length === 0 && (
                <tr><td colSpan={6 + sites.length} className="px-4 py-8 text-center text-sm text-ink-soft">{q ? 'No users match your search.' : 'No users yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {showInvite && (
        <InviteModal
          sites={sites}
          adminGroup={adminGroup}
          onClose={() => setShowInvite(false)}
          onInvited={(u) => { setUsers((l) => [...(l ?? []), u].sort((a, b) => a.email.localeCompare(b.email))); setFlash(`Invitation sent to ${u.email}`); setShowInvite(false); onChanged() }}
        />
      )}
    </div>
  )
}

/**
 * "Actions" button + dropdown. The menu is rendered through a portal with fixed positioning so the
 * table card's overflow (needed for horizontal scrolling) cannot clip it. Closes on outside click,
 * Escape, scroll or resize.
 */
function ActionsMenu({ open, onToggle, children }: { open: boolean; onToggle: (open: boolean) => void; children: React.ReactNode }) {
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    if (!open || !btn.current) { setPos(null); return }
    const r = btn.current.getBoundingClientRect()
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => onToggle(false)
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, onToggle])

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => onToggle(!open)}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink transition-colors hover:border-brand/60 hover:text-brand"
      >
        Actions
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && pos &&
        createPortal(
          <div ref={menu} role="menu" style={{ position: 'fixed', top: pos.top, right: pos.right }} className="z-50 w-56 rounded-xl border border-line bg-white py-1 text-left shadow-lg">
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={`block w-full px-3 py-2 text-left text-sm hover:bg-surface ${danger ? 'text-danger' : 'text-ink'}`}>
      {children}
    </button>
  )
}

function InviteModal({ sites, adminGroup, onClose, onInvited }: { sites: Site[]; adminGroup: string; onClose: () => void; onInvited: (u: AdminUser) => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [groups, setGroups] = useState<string[]>(sites.map((s) => s.group))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (g: string) => setGroups((gs) => (gs.includes(g) ? gs.filter((x) => x !== g) : [...gs, g]))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onInvited(await api.invite(email.trim(), name.trim(), groups))
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal title="Invite a user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="font-semibold">Email</span>
          <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-2 outline-none ring-brand/30 focus:border-brand focus:ring-2" placeholder="name@swagelok.com" />
        </label>
        <label className="block text-sm">
          <span className="font-semibold">Name <span className="font-normal text-ink-soft">(optional)</span></span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-line px-3 py-2 outline-none ring-brand/30 focus:border-brand focus:ring-2" />
        </label>
        <fieldset className="text-sm">
          <legend className="font-semibold">Access</legend>
          <div className="mt-1 space-y-1.5">
            {sites.map((s) => (
              <label key={s.group} className="flex items-center gap-2">
                <input type="checkbox" checked={groups.includes(s.group)} onChange={() => toggle(s.group)} className="accent-brand" /> {s.name}
              </label>
            ))}
            <label className="flex items-center gap-2 border-t border-line/50 pt-1.5">
              <input type="checkbox" checked={groups.includes(adminGroup)} onChange={() => toggle(adminGroup)} className="accent-brand" /> Admin (can use this app)
            </label>
          </div>
        </fieldset>
        <p className="text-xs text-ink-soft">Cognito emails a temporary password. At first sign-in they choose their own password and register an authenticator app.</p>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex justify-end gap-2 pt-1">
          <Button tone="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send invitation'}</Button>
        </div>
      </form>
    </Modal>
  )
}
