import { useCallback, useEffect, useState } from 'react'

/** Minimal client-side routing with real URLs, so the browser back button works on phones. */
export type Route =
  | { view: 'projects' }
  | { view: 'contacts' }
  | { view: 'users' }
  | { view: 'security' }
  | { view: 'project'; id: string; section: 'overview' | 'documents' | 'files' }
  | { view: 'document'; id: string }

const UUID = '[0-9a-f-]{36}'
const SECTIONS = { dokumente: 'documents', ablage: 'files' } as const

export function parseRoute(path: string): Route {
  const project = new RegExp(`^/projekte/(${UUID})(?:/(dokumente|ablage))?/?$`).exec(path)
  if (project) {
    const section = project[2] as keyof typeof SECTIONS | undefined
    return {
      view: 'project',
      id: project[1] as string,
      section: section ? SECTIONS[section] : 'overview',
    }
  }
  const document = new RegExp(`^/dokumente/(${UUID})/?$`).exec(path)
  if (document) return { view: 'document', id: document[1] as string }
  if (path.startsWith('/kontakte')) return { view: 'contacts' }
  if (path.startsWith('/benutzer')) return { view: 'users' }
  if (path.startsWith('/sicherheit')) return { view: 'security' }
  return { view: 'projects' }
}

export function pathOf(route: Route): string {
  switch (route.view) {
    case 'projects':
      return '/'
    case 'contacts':
      return '/kontakte'
    case 'users':
      return '/benutzer'
    case 'security':
      return '/sicherheit'
    case 'project':
      return `/projekte/${route.id}${
        route.section === 'documents' ? '/dokumente' : route.section === 'files' ? '/ablage' : ''
      }`
    case 'document':
      return `/dokumente/${route.id}`
  }
}

export type Navigate = (route: Route) => void

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = useCallback((next: Route) => {
    const path = pathOf(next)
    if (path !== window.location.pathname) window.history.pushState(null, '', path)
    setRoute(next)
    window.scrollTo(0, 0)
  }, [])
  return [route, navigate]
}
