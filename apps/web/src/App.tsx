import { useEffect, useState } from 'react'

interface Meta {
  name: string
  version: string
  profile: 'compact' | 'standard'
  role: string
}

type Status = 'loading' | 'ready' | 'unavailable'

/** Placeholder start page: proves web → proxy → API → database works end to end. */
export function App() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  useEffect(() => {
    fetch('/api/v1/meta')
      .then((res) => (res.ok ? (res.json() as Promise<Meta>) : null))
      .then((data) => {
        if (data) {
          setMeta(data)
          document.title = data.name
        }
      })
      .catch(() => setMeta(null))
    fetch('/readyz')
      .then((res) => setStatus(res.ok ? 'ready' : 'unavailable'))
      .catch(() => setStatus('unavailable'))
  }, [])

  const statusText: Record<Status, string> = {
    loading: 'Verbindung wird geprüft …',
    ready: 'System bereit',
    unavailable: 'Datenbank nicht erreichbar',
  }

  return (
    <main className="page">
      <section className="card" aria-live="polite">
        <h1>{meta?.name ?? 'OpenPlancraft'}</h1>
        <p className="lead">Betriebssoftware für Bau- und Handwerksbetriebe</p>
        <p className={`badge badge--${status}`}>{statusText[status]}</p>
        {meta && (
          <dl className="facts">
            <dt>Version</dt>
            <dd>{meta.version}</dd>
            <dt>Betriebsprofil</dt>
            <dd>{meta.profile === 'compact' ? 'Kompakt' : 'Standard'}</dd>
          </dl>
        )}
      </section>
    </main>
  )
}
