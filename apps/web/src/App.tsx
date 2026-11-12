import type { Me, SetupStatus } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { ApiError, api } from './api'
import { t } from './i18n'
import { clearOfflineData, setOfflineOwner } from './offline/client'
import { LoginScreen, SetupScreen } from './screens/auth'
import { InvitationScreen } from './screens/invitation'
import { Workspace } from './screens/workspace'

type State =
  | { screen: 'loading' }
  | { screen: 'error'; message: string }
  | { screen: 'setup' }
  | { screen: 'login' }
  | { screen: 'workspace'; me: Me }
  | { screen: 'invitation' }

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
    if (window.location.pathname === '/einladung') {
      setState({ screen: 'invitation' })
      return
    }
    ;(async () => {
      try {
        const status = await api<SetupStatus>('GET', '/api/v1/setup/status').catch(
          (error: unknown) => {
            // Without network the app opens with the data stored on the device (ADR 0010).
            if (error instanceof ApiError && error.status === 0) return { setupRequired: false }
            throw error
          },
        )
        if (status.setupRequired) return setState({ screen: 'setup' })
        const me = await api<Me>('GET', '/api/v1/auth/me')
        await setOfflineOwner(me)
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
        <LoginScreen
          appName={appName}
          onDone={(me) => {
            void setOfflineOwner(me)
            setState({ screen: 'workspace', me })
          }}
        />
      )
    case 'workspace':
      return (
        <Workspace
          me={state.me}
          onLogout={() => {
            void clearOfflineData()
            setState({ screen: 'login' })
          }}
          onMeChanged={(me) => setState({ screen: 'workspace', me })}
        />
      )
    case 'invitation':
      return (
        <InvitationScreen
          onDone={(me) => setState({ screen: 'workspace', me })}
          onLogin={() => setState({ screen: 'login' })}
        />
      )
  }
}
