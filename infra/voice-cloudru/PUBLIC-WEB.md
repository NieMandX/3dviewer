# Public web gateway on Cloud.ru

Owner approved migrating `agr.vision` DNS and opening only TCP 80/443 on
`viewer-voice-01` on 2026-10-26. Preserve the old Yandex domain layout:

- `agr.vision`: immutable viewer release, `www` redirects to the canonical host.
- `supabase.agr.vision`: Auth, REST, Storage and Realtime over verified private
  HTTPS to `10.0.0.5:8443`. No Studio, database ports or Auth admin endpoints.
- `voice-api.agr.vision`: authenticated Checker and existing 2GIS paths.

`Caddyfile.public` and `lpmview-public-web.service` run separately from the
accepted loopback-only staging proxy and LiveKit containers. Install the pinned,
verified Caddy 2.11.7 binary as `/usr/local/bin/lpmview-public-caddy`. Release files
live under `/srv/lpmview-viewer/.releases/<version>-<commit>`; never expose the
repository, server configuration, credentials or backups as the document root.

The root-owned `/etc/lpmview-public-web/release.env` selects `LPM_VIEWER_BUILD`.
Before changing DNS, set `LPM_WEB_BIND=127.0.0.1` and the four `LPM_*_SITE`
variables to `http://<original-domain>:8092`. This tests the exact routing privately
without issuing certificates or opening another public port. Validate Caddy,
test allowed/denied routes and a complete authenticated model download. Restore
the public site defaults only for the approved DNS cutover, then verify public
certificates, HTTP redirects, Auth, Storage, WebSockets and browser model loading.

The `agr-public-web` security group must be attached only to the voice VM. Keep
`agr-admin-ssh` unchanged and backend HTTPS limited to voice `10.0.0.6/32`.
The public gateway overwrites client-IP headers; only that private IP is trusted
by the internal backend gateway. Set `MODEL_CHECK_TRUST_PROXY=1` only while its
listener remains loopback-only and the public gateway overwrites
`X-Lpmview-Client-IP`. Preserve the existing localhost test origins when adding
`https://agr.vision` and `https://niemandx.github.io` to both APIs' CORS lists.

Use the new backend's **anon** key in the release runtime config, never a
service-role key. Set `voiceEnabled: false` on the new deployment until real
two-device media acceptance and separately approved media networking. The public
gateway returns 503 for `/v1/token` and does not forward LiveKit control, signaling
or media endpoints. This does not disable rooms, annotations or text chat.
The old `rtc`, `turn`, `api` and `assets` DNS records are not part of this web-only
cutover; do not change them speculatively.

Before updating backend public URL / Auth redirect settings or either API's
origins, keep a root-only rollback copy. Do not regenerate credentials or rerun
staging initialization. Preserve the source database, old DNS records and all
original backups. Hold `/run/lock/lpm-cloudru-migration.lock` during each server
mutation. Public availability is not proof of complete disaster recovery or
voice/2GIS readiness.
