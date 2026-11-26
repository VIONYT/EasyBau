# API-Beschreibung (OpenAPI)

`openapi.json` beschreibt die REST-API von EasyBau (`/api/v1`) im Format OpenAPI 3.1. Sie wird aus dem Quelltext erzeugt (`apps/api/src/openapi/generate.ts`):

- alle Routen (`app.get|post|put|patch|delete`) mit Pfad-Parametern,
- das geprüfte Recht (z. B. `contacts.write`) bzw. „Angemeldet“,
- Anfrage-Bodys und Query-Parameter aus den Zod-Schemas in `packages/schemas` (die einzige Quelle der API-Verträge),
- Fehler als RFC 9457 Problem Details.

Antworten sind als JSON beschrieben; ihre Typen stehen in `packages/schemas`.

Nach Änderungen an Routen oder Schemas neu erzeugen:

```bash
pnpm openapi
```

Ein Test (`apps/api/src/openapi/generate.test.ts`) schlägt fehl, wenn die Datei veraltet ist.

Anmeldung: Sitzungs-Cookie (`__Host-sid`, HttpOnly). Ändernde Anfragen werden nur von derselben Herkunft angenommen (CSRF); POST akzeptiert `Idempotency-Key`, PATCH verlangt `If-Match` mit dem ETag.
