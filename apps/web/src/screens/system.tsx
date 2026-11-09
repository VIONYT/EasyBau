import type { Me } from '@opc/schemas'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'

interface Meta {
  name: string
  version: string
  profile: string
  role: string
}

/** Betrieb: version and profile; e-mail, exports and backups are added here. */
export function SystemSettings({ me: _me }: { me: Me }) {
  const [meta, setMeta] = useState<Meta | null>(null)
  useEffect(() => {
    api<Meta>('GET', '/api/v1/meta')
      .then(setMeta)
      .catch(() => undefined)
  }, [])
  return (
    <div className="panel">
      <h2>{t('sys.title')}</h2>
      {meta ? (
        <dl className="facts">
          <dt>{t('sys.version')}</dt>
          <dd>
            {meta.name} {meta.version}
          </dd>
          <dt>{t('sys.profile')}</dt>
          <dd>{meta.profile}</dd>
        </dl>
      ) : null}
    </div>
  )
}
