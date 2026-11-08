import type { Me, SetupStatus } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { ApiError, api } from './api'
import { t } from './i18n'
import { LoginScreen, SetupScreen } from './screens/auth'
import { Workspace } from './screens/workspace'

type State =
  | { screen: 'loading' }
  | { screen: 'error'; message: string }
  | { screen: 'setup' }
  | { screen: 'login' }
  | { screen: 'workspace'; me: Me }

/** Start: setup required? → Ersteinrichtung; session valid? → workspace; otherwise login. */
export function App() {
  const [state, setState] = useState<State>({ screen: 'loading' })
  const [appName, setAppName] = useState('OpenPlancraft')

  useEffect(() => {
    api<{ name: string }>('GET', '/api/v1/meta')
      .then((meta) => {
        setAppName(meta.name)
        document.title = meta.name
      })
      .catch(() => undefined)
    ;(async () => {
      try {
        const status = await api<SetupStatus>('GET', '/api/v1/setup/status')
        if (status.setupRequired) return setState({ screen: 'setup' })
        const me = await api<Me>('GET', '/api/v1/auth/me')
        setState({ screen: 'workspace', me })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) setState({ screen: 'login' })
        else setState({ screen: 'error', message: (error as Error).message })
      }
    })()
  }, [])

  switch (state.screen) {
    case 'loading':
      return <p className="page muted">{t('common.loading')}</p>
    case 'error':
      return (
        <p className="page form-error" role="alert">
          {state.message}
        </p>
      )
    case 'setup':
      return <SetupScreen onDone={(me) => setState({ screen: 'workspace', me })} />
    case 'login':
      return (
        <LoginScreen appName={appName} onDone={(me) => setState({ screen: 'workspace', me })} />
      )
    case 'workspace':
      return <Workspace me={state.me} onLogout={() => setState({ screen: 'login' })} />
  }
}
