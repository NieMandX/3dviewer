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

## Server rollout

Do not run `schema.sql` against production: it is a destructive fresh-install
schema. Back up production, inspect ownership differences, then apply only
`migrations/20260902000100_project_administration.sql` in one transaction.

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
