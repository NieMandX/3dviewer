# Checker on the existing proxy VM

Owner approved sharing `viewer-voice-01` with the 2GIS/voice proxy on 2026-10-03.
No new VM or public port was created. The agr.vision frontend release stays
0.96; the new feature is enabled in GitHub Pages 0.97.3.

## Installed layout

- API: `https://voice-api.agr.vision/model-check`; Caddy strips the prefix.
  Existing voice/GIS routes use their original upstream.
- Private API listener: `172.18.0.1:8081`, reachable from the Caddy Docker bridge.
  Caddy overwrites `X-Lpmview-Client-IP`; never bind this trusted listener to a
  public interface. API limit: 300 requests/min/IP, 32 concurrent requests,
  128 connections; 4 KiB HTTP request body. SQL separately limits four active
  jobs/project and deduplicates an unchanged model/engine.
- API process uses DynamicUser, 256 MiB and 0.5 CPU; only an anon key + incoming
  user JWT. Worker credentials are never sent to the API/browser/container.
- Service code: `/opt/lpmview/checker/service`, root-owned; Node 22 runtime:
  `/opt/lpmview/checker/runtime/node22` (installed 22.23.3, upstream SHA verified).
- Protected configuration: `/etc/lpmview-checker/{api,worker}.env`, root 0600.
- Worker user: `lpm-checker`, UID/GID 1001, no login credentials/sudo/docker group.
  Rootless Docker has its own images/socket; the system Docker remains separate.
- `ProtectHome=yes` hides home/runtime directories. The worker namespace receives
  only its own socket at `/run/lpmview-checker/docker.sock` via a read-only bind.
  `DOCKER_HOST` is forwarded to the Python dispatcher; no database keys are.
- One worker; each Blender container has 2 CPU, 4 GiB, no swap, 128 PID,
  network none, read-only root/input, cap-drop ALL, no-new-privileges, 2 GiB
  temporary RAM filesystem. Container UID 0 maps to host UID 1001, not host root.
- `user-1001.slice` additionally caps the daemon/containers/worker together:
  2.5 CPU, 5 GiB, no swap, 512 tasks, low CPU/IO weight.
- Temporary filesystem: 16 GiB ext4 loop image
  `/var/lib/lpmview-checker-data/workspace.ext4`, mounted nosuid/nodev/noexec at
  `/var/lib/lpmview-checker/work`; mount recorded in fstab. This bounds disk
  damage even if a job does not clean up. It is not a second cloud disk.
- Worker requires 8 GiB free before starting, deletes the job after completion,
  and cleans only its labelled containers/job directories before restart.
- Current reports are retained in PostgreSQL until model deletion; cascade
  removes them with the model. No age-based purge is enabled.

These are service limits, not Moscow model requirements. Limits may cause
`incomplete`; they must never turn an interrupted run into a passing report.
The checked-in units are specific to this host's UID and Docker bridge. Recheck
both before installing them elsewhere.

## Immutable engine

Revision: `agr161-20261003-rootless2cpu4g`.

Linux image ID:
`sha256:95e190c710cd4957ae68f06367268a8e60832920f5b2451445995fdb54a0bfa7`.

Runner SHA-256:
`fb882509386e3c66843dc5a8b3d17c51126c0573a88c1262f4185fce2d6a1a43`.

The exported Docker Desktop manifest ID was
`sha256:2c5528575ba352073d37240d6439d762b7d5bd5136c72d716144068cfcf6aaeb`.
All nine RootFS layer digests and the entrypoint match after import; the Linux
store identifies the image by its config digest. Register the actual target
ID, never silently substitute a tag. Changing the runner/image requires a new
engine revision; the database rejects identity edits.

Checker original: SINTEZ AGR Checker 1.6.1, Blender 5.1.0, requirements 18.08.2026.
The vendor package/model files/knowledge base are private and not in this repo.

## Operation

```sh
sudo systemctl status lpmview-checker-api lpmview-checker-worker
sudo journalctl -u lpmview-checker-worker --since '1 hour ago'
sudo systemctl start lpmview-checker-health.service
sudo systemctl list-timers lpmview-checker-health.timer
sudo -iu lpm-checker docker ps
sudo df -h /var/lib/lpmview-checker/work
```

Health timer runs every five minutes and records failures in systemd/journal.
It checks process availability, the API endpoint and minimum free space; it is
not an external alerting service or proof of full queue processing. Local Docker
logs are bounded (2 x 10 MiB per container); containers are removed after a job.

Restart the worker after restarting its rootless Docker daemon, so its socket
bind is recreated. Stop the worker before maintenance of its filesystem or
before manually cleaning temporary files. Never use system Docker prune.
On shutdown the worker cancels its child and waits for cleanup; startup cleanup
covers an interrupted previous worker/host.

Disable the feature by clearing modelCheckApiUrl in the test frontend and
setting the engine's enabled=false. Stop the worker after current work is
handled; queued jobs remain in PostgreSQL. Preserve reports/schema on rollback.
Caddy backups are under `/var/backups/lpmview-checker/` on the proxy. No frontend
promotion or Object Storage sync is part of this deployment.

Database migration: `20261003000100_model_check_jobs.sql`, applied after verified
backup `db-20261003T110304Z.dump` on the backend VM. Storage metadata is read only.

## Validation

The NPM control archive completed on the target VM in 5.864 s; 39 passed,
2 failed, 3 warning, 28 not_checked, same as the local reference. Inspect data
confirmed network none, readonly input/root, exact image ID, 2 CPU/4 GiB, no
OOM and unchanged source SHA-256. The 61,428,549-byte APEX ZIP is present in real
Storage with a version and updated_at, and resolves via model_check_source.

Long-duration load, large simultaneous workloads, physical iPad and a real
multi-participant voice call during validation are not covered by this probe.

Rootless/cgroup reference: https://docs.docker.com/engine/security/rootless/tips/
