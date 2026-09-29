import type { ReactNode } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line/60 bg-white shadow-sm ${className}`}>{children}</div>
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'error' | 'ok' }) {
  const cls = {
    info: 'border-line/60 bg-white text-ink-soft',
    warn: 'border-warn/40 bg-warn-bg text-ink',
    error: 'border-danger/40 bg-danger-bg text-danger',
    ok: 'border-accent/50 bg-accent/10 text-ink',
  }[tone]
  return <div className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>
}

export function Button({
  children,
  onClick,
  tone = 'primary',
  type = 'button',
  disabled,
  small,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'primary' | 'secondary' | 'danger' | 'ghost'
  type?: 'button' | 'submit'
  disabled?: boolean
  small?: boolean
  title?: string
}) {
  const base = `inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${small ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm'}`
  const cls = {
    primary: 'bg-brand text-white hover:bg-brand-dark',
    secondary: 'border border-line bg-white text-ink hover:border-brand/60 hover:text-brand',
    danger: 'border border-danger/40 bg-white text-danger hover:bg-danger-bg',
    ghost: 'text-brand hover:bg-brand-light',
  }[tone]
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${cls}`}>
      {children}
    </button>
  )
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'brand' }) {
  const cls = {
    neutral: 'bg-surface text-ink-soft border-line/70',
    ok: 'bg-accent/15 text-ink border-accent/40',
    warn: 'bg-warn-bg text-warn border-warn/40',
    danger: 'bg-danger-bg text-danger border-danger/30',
    brand: 'bg-brand-light text-brand border-brand/30',
  }[tone]
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{children}</span>
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ink-soft">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin" aria-hidden>
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
      {label}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-brand' : 'bg-line'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  )
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-ink/40 p-4 pt-[10vh]" onClick={onClose} role="presentation">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-brand">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-soft hover:bg-surface hover:text-ink">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'neutral' {
  switch (status) {
    case 'CONFIRMED': return 'ok'
    case 'FORCE_CHANGE_PASSWORD': return 'warn'
    case 'RESET_REQUIRED': return 'warn'
    case 'COMPROMISED': return 'danger'
    default: return 'neutral'
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'CONFIRMED': return 'Active'
    case 'FORCE_CHANGE_PASSWORD': return 'Invited'
    case 'RESET_REQUIRED': return 'Password reset pending'
    case 'UNCONFIRMED': return 'Unconfirmed'
    default: return status
  }
}

export function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
