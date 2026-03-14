# GitHub -> Yandex Cloud Deploy (LPMVIEW)

## Goal

Make `gh-pages` the production branch:

- develop/fix features in GitHub
- merge/cherry-pick to `gh-pages`
- GitHub Actions automatically syncs viewer files to Yandex Object Storage

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
3. Production branch: `gh-pages`

Production update path:

1. Commit to feature branch.
2. Merge/cherry-pick to `gh-pages`.
3. Push `gh-pages`.
4. GitHub Action deploys to Yandex bucket.

## 3) Trigger Deploy

Automatic:

- any push to `gh-pages`

Manual:

- `Actions -> Deploy Viewer To Yandex Object Storage -> Run workflow`

## 4) What Gets Uploaded

Sync uploads only static viewer files:

- `index.html`
- `favicon.ico`
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

Action will redeploy previous working version.

## 7) Custom Domain (agr.vision)

Recommended setup:

1. Create a dedicated static bucket named `agr.vision`.
2. Keep model storage in another bucket (for example `maragojeep`).
3. Workflow in this repository already deploys to:
   - `YC_S3_BUCKET=agr.vision`
   - `YC_S3_PREFIX` empty
4. Enable static website hosting for the bucket:
   - index document: `index.html`
5. Configure HTTPS certificate for the bucket domain in Yandex Cloud.
6. Runtime backend config now lives in `config/runtime.js`.
   - Edit `supabaseUrl` and `supabaseAnonKey` there when switching backend.
   - After push to `gh-pages`, GitHub Action deploys the updated runtime config to Yandex Object Storage together with the static viewer.
7. In DNS, point `agr.vision` to the website endpoint (`ANAME/ALIAS` for apex domain).
