# 2GIS integration

## Security model

The browser never receives the 2GIS API key. Public map controls call the
application backend at `gisApiUrl`; the backend reads the key from the locked
`integration_secrets` table and forwards only the requests required by the
viewer.

Allowed public operations:

- Places geometry for buildings, roads, ground parking and administrative
  areas;
- radius up to 500 metres, ten records per page and five pages.

The proxy rejects other 2GIS item types, arbitrary fields, larger areas and
invalid query parameters. Public requests are rate-limited by client IP and are
not cached by the application service. Raster tiles are not requested or
proxied. The upstream URL, response errors and API key must not be logged.

The `2GIS` tab in the project administration modal is visible only to a
registered database-backed superuser. Every read, replacement and deletion of
the key is checked again by the backend against the current Supabase access
token and `is_superuser()`. The UI receives only a SHA-256 fingerprint and
timestamp, never the stored value.

## Database rollout

Apply only the additive migration after a database backup:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260903000100_secure_2gis_api_key.sql
```

The table has forced RLS, no policies for `anon` or `authenticated`, and
explicit grants only for `service_role`. Do not add a public getter RPC for the
secret.

## Backend configuration

The `services/voice-api` container requires these additional environment
variables:

```text
SUPABASE_URL=https://supabase.agr.vision
SUPABASE_SERVICE_ROLE_KEY=<server-only service role key>
VOICE_API_ALLOWED_ORIGINS=https://agr.vision,https://www.agr.vision,https://niemandx.github.io,http://127.0.0.1:5173,http://localhost:5173,null
```

`SUPABASE_SERVICE_ROLE_KEY` must exist only on the VM/container. It must never
be copied into `config/runtime.js`, GitHub secrets used for static deployment,
browser storage or logs.

Static runtime configuration points the 2GIS environment mode at the backend:

```js
gisApiUrl: 'https://voice-api.agr.vision'
```

After deploying the migration and backend, a superuser opens `СОСТАВ` ->
`2ГИС`, saves a key with Places API access and then verifies
`Окружение 2ГИС` in a georeferenced room while signed out.
