import { useEffect, useState } from 'react'
import { api, type Actor, type Site } from './lib/api.ts'
import { Notice, Spinner } from './components/ui.tsx'
import UsersPage from './pages/UsersPage.tsx'
import AuditPage from './pages/AuditPage.tsx'

type Tab = 'users' | 'audit'

/** The Cognito gate handles /signout in production; nothing to sign out of on localhost. */
const SIGN_OUT_PATH = window.location.hostname.endsWith('swageloklabs.com') ? '/signout' : null

export default function App() {
  const [me, setMe] = useState<Actor | null>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [adminGroup, setAdminGroup] = useState('admins')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(() => (window.location.hash === '#audit' ? 'audit' : 'users'))
  const [auditKey, setAuditKey] = useState(0)

  useEffect(() => {
    Promise.all([api.me(), api.sites()])
      .then(([actor, s]) => { setMe(actor); setSites(s.sites); setAdminGroup(s.adminGroup) })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => { window.location.hash = tab === 'audit' ? '#audit' : '' }, [tab])

  return (
    <div className="flex min-h-full flex-col">
      <header className="bg-brand text-white shadow-md">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3 sm:px-6">
          <img src="/brand/swagelok-logo-reversed.png" alt="Swagelok" className="h-7 sm:h-8" />
          <div className="h-7 w-px bg-white/30" aria-hidden />
          <div className="leading-tight">
            <div className="font-display text-base font-bold tracking-wide sm:text-lg">Labs Admin</div>
            <div className="hidden text-xs text-white/75 sm:block">Users and access for the swageloklabs.com sites</div>
          </div>
          <nav className="ml-6 flex gap-1" aria-label="Sections">
            {(['users', 'audit'] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${tab === t ? 'bg-white text-brand' : 'text-white/85 hover:bg-white/15 hover:text-white'}`}
                aria-current={tab === t ? 'page' : undefined}
              >
                {t === 'users' ? 'Users' : 'Audit trail'}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-white/80">
            {me && <span className="hidden sm:inline">{me.email}</span>}
            {SIGN_OUT_PATH && (
              <a href={SIGN_OUT_PATH} className="rounded-full border border-white/30 px-3 py-1 font-medium text-white/85 transition-colors hover:border-white/60 hover:bg-white/10 hover:text-white">
                Sign out
              </a>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 sm:px-6">
        {error ? (
          <Notice tone="error">
            {error}
            {/403/.test(error) || /admins/.test(error) ? ' Ask an existing admin to grant you access.' : ''}
          </Notice>
        ) : !me ? (
          <Spinner label="Checking your access…" />
        ) : tab === 'users' ? (
          <UsersPage me={me} sites={sites} adminGroup={adminGroup} onChanged={() => setAuditKey((k) => k + 1)} />
        ) : (
          <AuditPage refreshKey={auditKey} />
        )}
      </main>

      <footer className="px-4 py-3 text-center text-[11px] text-ink-soft sm:px-6">
        Shared sign-in pool for {sites.map((s) => s.name).join(', ') || 'the swageloklabs.com sites'}. For internal Swagelok use.
      </footer>
    </div>
  )
}
