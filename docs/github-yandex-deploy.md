# GitHub -> Yandex Cloud Deploy (LPMVIEW)

## Goal

Use `gh-pages` for the current tested viewer build:

- develop/fix features in GitHub
- merge/cherry-pick to `gh-pages`
- pushes publish to GitHub Pages and run CI checks
- Yandex Object Storage sync is manual, off by default, and requires separate
  explicit owner approval (policy effective 2026-09-25)

The public `agr.vision` domain is a separately promoted release on Caddy,
not a direct alias of this bucket. A push updates only GitHub Pages, not
Object Storage or the domain's pinned release.
See [Viewer releases](viewer-releases.md) for promotion and rollback.

Workflow file:

- `.github/workflows/deploy-yc-storage.yml`

## 1) GitHub Secrets

In repository settings open:

- `Settings -> Secrets and variables -> Actions -> New repository secret`

Create secrets:

1. `YC_S3_ACCESS_KEY_ID`
2. `YC_S3_SECRET_ACCESS_KEY`
3. `YC_S3_BUCKET` (optional; currently fixed in workflow as `agr.vision`)
4. `YC_S3_PREFIX` (optional; currently fixed as empty for bucket root)

Important:

- Do not deploy to bucket root if the same bucket stores models.
- Keep viewer in a dedicated prefix (`viewer-prod/`) or a separate bucket.
- `YC_S3_PREFIX` is optional. If empty, deploy goes to bucket root.

## 2) Branch Strategy

Recommended:

1. Work branch: `feature/*`
2. Integration branch: `main` (optional)
3. Test publication branch: `gh-pages`

Test update path:

1. Commit to feature branch.
2. Merge/cherry-pick to `gh-pages`.
3. Push `gh-pages`.
4. GitHub Pages publishes the build; CI runs without syncing the Yandex bucket.

## 3) Trigger Deploy

Automatic checks:

- any push to `gh-pages`; the Yandex sync job is skipped

Manual Yandex sync (only after separate owner approval):

- `Actions -> Viewer CI And Optional Yandex Sync -> Run workflow`
- select the approved branch/ref and enable `sync_yandex`
- the checkbox defaults to off; a manual run without it only executes checks
- syncing the bucket does not promote the Caddy release on `agr.vision`

## 4) What Gets Uploaded

Sync uploads only static viewer files:

- `index.html`
- `version.json`
- `favicon.ico`
- `config/*`
- `scripts/*`
- `styles/*`
- `hdr/*`
- `textures/*`
- `exr/*`

Deploy target is:

- `s3://<YC_S3_BUCKET>/<YC_S3_PREFIX>/`

`--delete` affects only this prefix.

If `YC_S3_PREFIX` is empty, deploy target becomes:

- `s3://<YC_S3_BUCKET>/`

## 5) Verify Deploy

Check GitHub Actions run is green, then list objects:

```bash
aws --profile yc-s3 --endpoint-url https://storage.yandexcloud.net s3 ls s3://maragojeep --recursive --human-readable --summarize

aws --profile yc-s3 --endpoint-url https://storage.yandexcloud.net s3 ls s3://maragojeep/viewer-prod/ --recursive --human-readable --summarize
```

## 6) Rollback

Use git rollback on `gh-pages` and push:

```bash
git checkout gh-pages
git log --oneline -n 5
git revert <bad_commit_sha>
git push origin gh-pages
```

The push will publish the reverted build to GitHub Pages only. Object Storage
needs a separately approved manual sync.
For `agr.vision`, use the separate Caddy release rollback described in
[Viewer releases](viewer-releases.md).

## 7) Custom Domain (agr.vision)

Current routing, verified on 2026-09-02:

- DNS points to `viewer-voice-01` (`93.77.182.247`), with HTTPS served by
  the `deploy-caddy-1` container.
- Static files are bind-mounted from `/opt/lpmview/viewer/current` to `/srv`.
- The domain's Caddy root selects a complete staged release. Other Caddy
  virtual hosts provide voice API and LiveKit; do not recreate the stack to
  publish viewer files.
- `s3://agr.vision/` is a separate copy populated only by an explicitly enabled
  manual sync in this workflow.
- `config/runtime.js` supplies the current Supabase and voice API endpoints.
  Include it when packaging a domain release.
