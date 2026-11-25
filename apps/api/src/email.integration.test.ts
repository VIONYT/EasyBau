import { withTenant } from '@easybau/db'
import type { EmailMessageSummary } from '@easybau/schemas'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, createHarness, type Harness } from './testing/harness.js'

async function setup(h: Harness) {
  const admin = new Client(h.app)
  const res = await admin.post('/api/v1/setup', {
    setupToken: h.setupToken,
    company: { name: 'Mail Bau GmbH', email: 'buero@mail-bau.example' },
    admin: {
      email: 'chef@example.test',
      password: 'ein-sehr-langes-passwort',
      displayName: 'Chef',
    },
  })
  return { admin, tenantId: res.json().tenant.id as string }
}

describe.skipIf(!process.env.DATABASE_URL)('E-Mail-Versand (integration)', () => {
  describe('mit SMTP', () => {
    let h: Harness
    let admin: Client
    let tenantId: string
    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false, smtp: true })
      ;({ admin, tenantId } = await setup(h))
    })
    afterAll(async () => {
      await h?.close()
    })

    it('reports the configuration without secrets', async () => {
      expect((await admin.get('/api/v1/settings/email')).json()).toEqual({
        enabled: true,
        from: 'Test-ERP <noreply@example.test>',
      })
    })

    it('queues invitation e-mails in the same transaction', async () => {
      const res = await admin.post('/api/v1/invitations', {
        email: 'neu@example.test',
        displayName: 'Nina Neu',
        roleKey: 'team_member',
        sendEmail: true,
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().emailQueued).toBe(true)
      const [message] = await withTenant(
        h.sql,
        { tenantId },
        (tx) =>
          tx<{ to: string; replyTo: string; subject: string; body: string; status: string }[]>`
          select to_address as to, reply_to as "replyTo", subject, body_text as body, status from email_message`,
      )
      expect(message).toMatchObject({
        to: 'neu@example.test',
        replyTo: 'buero@mail-bau.example',
        subject: 'Einladung zu Mail Bau GmbH',
        status: 'queued',
      })
      expect(message?.body).toContain(res.json().acceptUrl)
      expect(message?.body).toContain('Hallo Nina Neu,')
      // Without sendEmail only the link is shown.
      const quiet = await admin.post('/api/v1/invitations', {
        email: 'still@example.test',
        roleKey: 'team_member',
      })
      expect(quiet.json().emailQueued).toBe(false)
    })

    it('sends test e-mails and lists the outbox', async () => {
      expect((await admin.post('/api/v1/settings/email/test', {})).statusCode).toBe(202)
      const list: EmailMessageSummary[] = (
        await admin.get('/api/v1/settings/email/messages')
      ).json()
      expect(list.map((m) => [m.kind, m.toAddress, m.status])).toEqual([
        ['test', 'chef@example.test', 'queued'],
        ['invitation', 'neu@example.test', 'queued'],
      ])
      expect(JSON.stringify(list)).not.toContain('einladung#')
    })
  })

  describe('ohne SMTP', () => {
    let h: Harness
    let admin: Client
    beforeAll(async () => {
      h = await createHarness({ requireAdminMfa: false })
      ;({ admin } = await setup(h))
    })
    afterAll(async () => {
      await h?.close()
    })

    it('does not queue anything and says why', async () => {
      expect((await admin.get('/api/v1/settings/email')).json().enabled).toBe(false)
      const test = await admin.post('/api/v1/settings/email/test', {})
      expect(test.statusCode).toBe(409)
      expect(test.json().detail).toMatch(/SMTP_HOST/)
      const invite = await admin.post('/api/v1/invitations', {
        email: 'x@example.test',
        roleKey: 'team_member',
        sendEmail: true,
      })
      expect(invite.json().emailQueued).toBe(false)
    })
  })
})
