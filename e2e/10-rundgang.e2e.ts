import { expect, test } from '@playwright/test'
import { type AdminSession, SCREENSHOTS, SETUP_TOKEN, session } from './support'

test.describe.configure({ mode: 'serial' })

// Logged-in admin with the virtual security key (from 01-einrichtung, or restored from disk).
let page: AdminSession['page']
test.beforeAll(async ({ browser }) => {
  ;({ page } = await session(browser))
})

// Screenshot-Rundgang: every screen once with the data of the tests above (only with
// SCREENSHOT_DIR, e.g. for the handbook or a review on MacBook and iPhone).
test('Screenshot-Rundgang über alle Oberflächen', async () => {
  test.skip(!SETUP_TOKEN || !SCREENSHOTS, 'only for screenshots (SCREENSHOT_DIR)')
  test.setTimeout(300_000)
  const json = async <T>(path: string) => (await (await page.request.get(path)).json()) as T
  const projects = (
    await json<{ items: { id: string; name: string }[] }>('/api/v1/projects?limit=100')
  ).items
  const project = projects.find((p) => p.name.includes('Lindenweg')) ?? projects[0]
  const projectId = project?.id as string
  const documents = await json<{ id: string; type: string; status: string }[]>(
    `/api/v1/projects/${projectId}/documents`,
  )
  const firstOf = (type: string) => documents.find((d) => d.type === type)?.id
  const sheets = await json<{ id: string }[]>(`/api/v1/projects/${projectId}/measurement-sheets`)
  const reports = await json<{ id: string; templateKey?: string }[]>(
    `/api/v1/projects/${projectId}/reports`,
  )
  const contacts = (await json<{ items: { id: string }[] }>('/api/v1/contacts?q=')).items
  const incoming = (await json<{ items: { id: string }[] }>('/api/v1/incoming-invoices')).items
  const shots: [string, string | undefined][] = [
    ['01-uebersicht', '/'],
    ['02-suche', '/suche?q=Lindenweg'],
    ['03-benachrichtigungen', '/benachrichtigungen'],
    ['04-projekte', '/projekte'],
    ['05-projekt-uebersicht', `/projekte/${projectId}`],
    ['06-projekt-dokumente', `/projekte/${projectId}/dokumente`],
    ['07-projekt-aufmass', `/projekte/${projectId}/aufmass`],
    ['08-projekt-bautagebuch', `/projekte/${projectId}/bautagebuch`],
    ['09-projekt-berichte', `/projekte/${projectId}/berichte`],
    ['10-projekt-ablage', `/projekte/${projectId}/ablage`],
    ['11-angebot', firstOf('quote') && `/dokumente/${firstOf('quote')}`],
    ['12-angebot-druckansicht', firstOf('quote') && `/dokumente/${firstOf('quote')}/druck`],
    [
      '13-auftragsbestaetigung',
      firstOf('order_confirmation') && `/dokumente/${firstOf('order_confirmation')}`,
    ],
    ['14-nachtrag', firstOf('change_order') && `/dokumente/${firstOf('change_order')}`],
    ['15-rechnung', firstOf('invoice') && `/dokumente/${firstOf('invoice')}`],
    ['16-aufmassblatt', sheets[0] && `/aufmass/${sheets[0].id}`],
    ['17-bericht', reports[0] && `/berichte/${reports[0].id}`],
    ['18-kontakte', '/kontakte'],
    ['19-kontakt', contacts[0] && `/kontakte/${contacts[0].id}`],
    ['20-rechnungen', '/rechnungen'],
    ['21-eingangsrechnungen', '/eingangsrechnungen'],
    ['22-eingangsrechnung', incoming[0] && `/eingangsrechnungen/${incoming[0].id}`],
    ['23-stammdaten', '/stammdaten'],
    ['24-pruefung', '/pruefung'],
    ['25-benutzer', '/benutzer'],
    ['26-sicherheit', '/sicherheit'],
  ]
  const sections = [
    'company',
    'numbers',
    'paymentTerms',
    'taxRates',
    'surcharges',
    'wageGroups',
    'units',
    'workingHours',
    'holidays',
    'texts',
    'documents',
    'letterhead',
    'filing',
    'datev',
    'areas',
    'mail',
    'incomingMail',
    'dunning',
    'system',
  ]
  sections.forEach((section, index) => {
    shots.push([`${30 + index}-einstellungen-${section}`, `/einstellungen?bereich=${section}`])
  })
  for (const [name, path] of shots) {
    if (!path) continue
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('Wird geladen …')).toHaveCount(0)
    await page.screenshot({ path: `${SCREENSHOTS}/tour/${name}.png`, fullPage: true })
  }
})
