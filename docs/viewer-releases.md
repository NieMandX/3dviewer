# Viewer releases

## Versions

- **0.9**: exact viewer previously served by `https://agr.vision/`, captured
  on 2026-09-02 before replacement. This is a deployed-file snapshot, not a
  guessed historical Git tag. Its original files are unchanged.
- **0.95**: current application release, identified by `version.json`, the
  page title/footer, and `appVersion` in runtime diagnostics. The `v0.95` Git
  tag identifies its source. This is the viewer version, not the Three.js version.

GitHub Pages and Yandex Object Storage follow `gh-pages`. The `agr.vision`
domain is explicitly promoted and remains pinned until another release is
approved; subsequent test pushes do not silently change production.

## 0.9 Backup

On `viewer-voice-01`, root-only files under `/var/backups/lpmview-viewer/`:

`agr-vision-0.9-20260902T201505Z.tar.gz`

Adjacent files contain the original Caddyfile, release label, archive SHA-256,
and per-file checksums. The archive was extracted into a temporary directory
and every file was verified against the original source. A second copy is
kept outside this repository in the local `LPMVIEW/backups/` directory.

Archive SHA-256:

`857f7163fdd6ec1f83571f416ac2f38bb48c1196ddc0bc1ef048fd71d1dcf700`

This archive contains frontend assets and public runtime configuration, not
the Supabase database or model storage. Database backups are separate.

## Promotion

1. Run `npm run ci:verify`, commit, push and tag the approved source.
2. Package only `index.html`, `version.json`, `favicon.ico`, `config`, `scripts`,
   `styles`, `hdr`, `textures` and `exr` from the Git tag. Never package the
   entire working directory or environment/credential files.
3. Verify the archive SHA-256 on the server and extract into a fresh
   `/opt/lpmview/viewer/current/.releases/<version>` directory. Never overwrite
   files of an active release. The 0.95 Caddy root is `/srv/.releases/0.95`.
4. Copy the candidate Caddyfile into the existing container and run
   `caddy validate` before activation. Change only the `agr.vision` block;
   preserve the voice API, LiveKit and www redirect blocks.
5. Copy the validated file over the existing host Caddyfile **in place**, then
   use `caddy reload`. The Caddyfile is a file bind mount: replacing its inode
   with `mv` would leave the container reading the old file. Do not restart the
   Docker stack or switch the host `current` directory out from under its mount.
6. Check public HTML/module/asset hashes, `/version.json`, the version header,
   browser boot, desktop/mobile footer layout, and voice service health.
   Viewer HTML/code use `Cache-Control: no-cache` for browser revalidation.

## Rollback To 0.9

The original 0.9 files remain directly under `/opt/lpmview/viewer/current`.
The old Caddyfile selects `/srv`, so no file replacement is required:

```sh
sudo cp /var/backups/lpmview-viewer/agr-vision-0.9-20260902T201505Z.Caddyfile /opt/lpmview/deploy/caddy/Caddyfile
sudo docker exec deploy-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker exec deploy-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Confirm the public `index.html` hash matches the archived original. If the old
directory was later removed, first restore the archive to a staging directory,
verify the per-file checksums, and mount/select that complete directory before
reloading. Do not unpack an archive over an active release.
