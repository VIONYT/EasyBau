import { useCallback, useEffect, useState } from 'react'

/** Minimal client-side routing with real URLs, so the browser back button works on phones. */
export type Route =
  | { view: 'dashboard' }
  | { view: 'search'; q: string }
  | { view: 'notifications' }
  | { view: 'projects' }
  | { view: 'contacts' }
  | { view: 'invoices' }
  | { view: 'incoming' }
  | { view: 'incomingInvoice'; id: string }
  | { view: 'users' }
  | { view: 'security' }
  | { view: 'catalog' }
  | { view: 'settings'; section?: string }
  | { view: 'audit' }
  | { view: 'project'; id: string; section: ProjectSection }
  | { view: 'document'; id: string }
  | { view: 'print'; id: string }
  | { view: 'measurement'; id: string }
  | { view: 'report'; id: string }

export type ProjectSection =
  | 'overview'
  | 'documents'
  | 'measurements'
  | 'diary'
  | 'reports'
  | 'files'

const UUID = '[0-9a-f-]{36}'
const SECTIONS = {
  dokumente: 'documents',
  aufmass: 'measurements',
  bautagebuch: 'diary',
  berichte: 'reports',
  ablage: 'files',
} as const

export function parseRoute(path: string, search = ''): Route {
  const project = new RegExp(
    `^/projekte/(${UUID})(?:/(dokumente|aufmass|bautagebuch|berichte|ablage))?/?$`,
  ).exec(path)
  if (project) {
    const section = project[2] as keyof typeof SECTIONS | undefined
    return {
      view: 'project',
      id: project[1] as string,
      section: section ? SECTIONS[section] : 'overview',
    }
  }
  const print = new RegExp(`^/dokumente/(${UUID})/druck/?$`).exec(path)
  if (print) return { view: 'print', id: print[1] as string }
  const document = new RegExp(`^/dokumente/(${UUID})/?$`).exec(path)
  if (document) return { view: 'document', id: document[1] as string }
  const measurement = new RegExp(`^/aufmass/(${UUID})/?$`).exec(path)
  if (measurement) return { view: 'measurement', id: measurement[1] as string }
  const incoming = new RegExp(`^/eingangsrechnungen/(${UUID})/?$`).exec(path)
  if (incoming) return { view: 'incomingInvoice', id: incoming[1] as string }
  if (path.startsWith('/eingangsrechnungen')) return { view: 'incoming' }
  const report = new RegExp(`^/berichte/(${UUID})/?$`).exec(path)
  if (report) return { view: 'report', id: report[1] as string }
  if (path.startsWith('/stammdaten')) return { view: 'catalog' }
  if (path.startsWith('/projekte')) return { view: 'projects' }
  if (path.startsWith('/benachrichtigungen')) return { view: 'notifications' }
  if (path.startsWith('/suche')) {
    return { view: 'search', q: new URLSearchParams(search).get('q') ?? '' }
  }
  if (path.startsWith('/einstellungen')) {
    const section = new URLSearchParams(search).get('bereich')
    return section ? { view: 'settings', section } : { view: 'settings' }
  }
  if (path.startsWith('/kontakte')) return { view: 'contacts' }
  if (path.startsWith('/rechnungen')) return { view: 'invoices' }
  if (path.startsWith('/benutzer')) return { view: 'users' }
  if (path.startsWith('/pruefung')) return { view: 'audit' }
  if (path.startsWith('/sicherheit')) return { view: 'security' }
  return { view: 'dashboard' }
}

export function pathOf(route: Route): string {
  switch (route.view) {
    case 'dashboard':
      return '/'
    case 'projects':
      return '/projekte'
    case 'notifications':
      return '/benachrichtigungen'
    case 'search':
      return `/suche?q=${encodeURIComponent(route.q)}`
    case 'contacts':
      return '/kontakte'
    case 'catalog':
      return '/stammdaten'
    case 'settings':
      return route.section
        ? `/einstellungen?bereich=${encodeURIComponent(route.section)}`
        : '/einstellungen'
    case 'users':
      return '/benutzer'
    case 'security':
      return '/sicherheit'
    case 'invoices':
      return '/rechnungen'
    case 'incoming':
      return '/eingangsrechnungen'
    case 'incomingInvoice':
      return `/eingangsrechnungen/${route.id}`
    case 'audit':
      return '/pruefung'
    case 'project': {
      const segment = {
        overview: '',
        documents: '/dokumente',
        measurements: '/aufmass',
        diary: '/bautagebuch',
        reports: '/berichte',
        files: '/ablage',
      }
      return `/projekte/${route.id}${segment[route.section]}`
    }
    case 'document':
      return `/dokumente/${route.id}`
    case 'print':
      return `/dokumente/${route.id}/druck`
    case 'measurement':
      return `/aufmass/${route.id}`
    case 'report':
      return `/berichte/${route.id}`
  }
}

export type Navigate = (route: Route) => void

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname, window.location.search),
  )
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname, window.location.search))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = useCallback((next: Route) => {
    const path = pathOf(next)
    if (path !== window.location.pathname + window.location.search) {
      window.history.pushState(null, '', path)
    }
    setRoute(next)
    window.scrollTo(0, 0)
  }, [])
  return [route, navigate]
}
