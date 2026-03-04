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
3. `YC_S3_BUCKET` (example: `maragojeep`)
4. `YC_S3_PREFIX` (example: `viewer-prod`)

Important:

- Do not deploy to bucket root if the same bucket stores models.
- Keep viewer in a dedicated prefix (`viewer-prod/`) or a separate bucket.

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
