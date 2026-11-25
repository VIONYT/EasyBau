import type { Me, SetupStatus } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { ApiError, api } from './api'
import { t } from './i18n'
import { clearOfflineData, setOfflineOwner } from './offline/client'
import { EmailChangeScreen, EmailVerifyScreen, PasswordResetScreen } from './screens/account'
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
  | { screen: 'passwordReset' }
  | { screen: 'emailVerify' }
  | { screen: 'emailChange' }

/** Start: setup required? → Ersteinrichtung; session valid? → workspace; otherwise login. */
export function App() {
  const [state, setState] = useState<State>({ screen: 'loading' })
  const [appName, setAppName] = useState('EasyBau')

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
    if (window.location.pathname === '/passwort-zuruecksetzen') {
      setState({ screen: 'passwordReset' })
      return
    }
    if (window.location.pathname === '/email-bestaetigen') {
      setState({ screen: 'emailVerify' })
      return
    }
    if (window.location.pathname === '/email-aendern') {
      setState({ screen: 'emailChange' })
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
    case 'passwordReset':
      return <PasswordResetScreen appName={appName} onLogin={() => setState({ screen: 'login' })} />
    case 'emailVerify':
      return <EmailVerifyScreen appName={appName} onContinue={() => window.location.assign('/')} />
    case 'emailChange':
      return <EmailChangeScreen appName={appName} onContinue={() => window.location.assign('/')} />
    case 'invitation':
      return (
        <InvitationScreen
          onDone={(me) => setState({ screen: 'workspace', me })}
          onLogin={() => setState({ screen: 'login' })}
        />
      )
  }
}
