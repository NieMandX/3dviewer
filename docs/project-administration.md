# Project and room administration

## Access model

| Action | Registered user | Invited room participant | Superuser |
| --- | --- | --- | --- |
| Create a project | Yes, owned by the creator | Only with a registered account, outside the invited project | Yes |
| List managed projects | Own projects | No administration access to the invited project | All projects |
| Create, rename or delete rooms | Inside own projects | No | Inside any project |
| Rename or delete projects | Own projects | No | Any project |
| Read room content | Own rooms and individually invited rooms | Invited room only | All rooms |
| Upload or delete models | Own projects | No | Any project |
| Add annotations, cameras and chat messages | Accessible room | Invited room | Any room |
| List registered accounts | No | No | All registered accounts, including those without projects |
| Configure the shared 2GIS API key | No | No | Yes; the key remains server-side |

A participant can own one project and be a guest in somebody else's room.
Registration alone is not an entitlement to other users' projects.
Guests can read minimal parent-project metadata for the invited room, but cannot
enumerate the project's other rooms. Administration lists remain owner-scoped.

`projects.owner_id` is the ownership authority. A room inherits that owner, even
when a superuser creates it. `user_roles(superuser)` is a server-side grant, not
a role inferred from an email supplied by the browser. The existing bootstrap
migration targets `maragojeep@gmail.com`; live assignment must be checked in DB.

## Management UI

The existing content modal opens on the Projects tab after registered login,
without joining or loading a room. Empty projects are listed. Projects start
collapsed, preserve expansion during operations, and can be filtered. Creation
and renaming do not change the active scene. Destructive actions use explicit
confirmation and require the server to return the deleted row.

Models, annotations and cameras retain their existing tabs. Opening Projects
does not fetch every annotation payload or camera in every room. Owners' emails
come from `project_admin_owners`, restricted to manageable projects; an older
backend falls back to owner IDs.

The Users tab is visible only to a superuser, independently of the project
filter. It shows email, profile name, database-backed role, registration and
last-sign-in dates, and email confirmation status. Email/name search uses literal
case-insensitive matching, with 50 users per page (server maximum 100).
Anonymous and soft-deleted Auth accounts are excluded; unconfirmed registered
accounts remain visible. Account deletion, role changes, passwords, identities,
and session/token details are not exposed.

The 2GIS tab is also superuser-only. It shows whether the shared key is
configured, its non-reversible fingerprint and update time. The browser can
replace or delete the key through the backend, but cannot read it. Public map
requests use the backend proxy without requiring a viewer account; see
`docs/2gis-integration.md`.

`admin_list_registered_users` checks the registered caller and the database role
on every request. It does not grant clients access to `auth.users`. Closing the
modal aborts its request and clears directory data; generation and account
checks reject stale responses after close/reopen or app disposal.

## Server rollout

Do not run `schema.sql` against production: it is a destructive fresh-install
schema. Back up production, inspect ownership differences, then apply only
`migrations/20260902000100_project_administration.sql`, followed by
`migrations/20260902000200_superuser_user_directory.sql`, in one transaction.
The second migration only adds the read-only directory RPC and its grants;
it does not assign or change any user's role. Until applied, the Users tab
reports that a database update is required, rather than showing a false empty list.

Preflight queries:

```sql
select u.email, ur.role from public.user_roles ur
join auth.users u on u.id = ur.user_id where ur.role = 'superuser';

select r.id, r.slug, r.owner_id as room_owner, p.owner_id as project_owner
from public.rooms r join public.projects p on p.id = r.project_id
where r.owner_id is distinct from p.owner_id;
```

The migration aligns room ownership, protects identity columns from browser
updates, and removes the legacy join-by-slug privilege escalation. Existing
members may navigate by slug; new guests must supply a valid room invitation.
Existing membership rows are intentionally retained. It does not revoke old
invitations or make all existing members leave their rooms.

## Verification

- `npm run ci:verify`: owner-only UI, empty projects, create/rename/delete without
  entering a room, guest and superuser boundaries, desktop/mobile layout.
- `supabase/tests/bootstrap.sql`: isolated PostgreSQL test database ONLY.
- `supabase/tests/project-administration.sql`: real RLS allow/deny tests, invite
  isolation, column permissions, superuser access and cascade deletion of room
  data. The database-permissions workflow runs these against PostgreSQL 17.
- `supabase/tests/user-directory.sql`: direct API denial for owners/guests,
  safe-field allowlist, role revocation, search, pagination, and account filtering.
- `scripts/ci/smoke-user-directory.mjs`: actual login and tab flow against a fake
  backend, search/pages, empty/error states, HTML escaping, close/reopen races,
  disposal and desktop/mobile screenshots. Browser plugin not available;
  validation uses the repository's Playwright smoke runner.

## Remaining administration work

- Audited invitation rotation, explicit member revocation and participant lists.
- Delete audit log, recovery policy, and a reliable server-side Storage cleanup
  job. Existing project deletion performs best-effort client cleanup, and room
  deletion retains project-level models. SQL removal of Storage metadata does
  not prove the S3 object was removed. Do not present this as guaranteed physical
  deletion of every file yet.
- Ownership transfer requires a separate explicit operation; it is not exposed
  through generic project/room edits.
- Define editing/deletion rights for other participants' cameras and messages
  before adding moderation controls. This change preserves current policies.
