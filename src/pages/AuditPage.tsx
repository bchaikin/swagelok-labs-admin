import { useEffect, useState } from 'react'
import { api, type AuditEntry } from '../lib/api.ts'
import { Button, Card, Chip, Notice, Spinner, fmtDate } from '../components/ui.tsx'

const ACTION_LABEL: Record<string, string> = {
  'user.invite': 'Invited',
  'user.update': 'Updated',
  'user.delete': 'Deleted',
  'user.groups': 'Access changed',
  'user.resend-invite': 'Invitation re-sent',
  'user.reset-password': 'Password reset',
  'user.reset-mfa': 'MFA reset',
  'user.sign-out': 'Signed out everywhere',
}

export default function AuditPage({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState(100)

  useEffect(() => {
    setEntries(null)
    api.audit(limit).then(setEntries).catch((e: Error) => setError(e.message))
  }, [limit, refreshKey])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="font-display text-xl font-bold text-ink">Audit trail</h1>
          <p className="text-sm text-ink-soft">Every change made through this app, newest first.</p>
        </div>
        <div className="ml-auto">
          {entries && entries.length >= limit && <Button tone="secondary" small onClick={() => setLimit(limit + 200)}>Show more</Button>}
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!entries ? (
        <Spinner label="Loading audit trail…" />
      ) : entries.length === 0 ? (
        <Notice>No actions recorded yet.</Notice>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-surface text-[11px] uppercase tracking-wide text-ink-soft">
              <tr>
                <th className="px-4 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">Admin</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`} className="hover:bg-surface/60">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-ink-soft">{fmtDate(e.at)}</td>
                  <td className="px-3 py-2">{e.actor}</td>
                  <td className="px-3 py-2"><Chip tone={e.action === 'user.delete' ? 'danger' : e.action === 'user.invite' ? 'ok' : 'brand'}>{ACTION_LABEL[e.action] ?? e.action}</Chip></td>
                  <td className="px-3 py-2">{e.target}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-ink-soft">{e.details ? summarize(e.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

function summarize(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ')
}
