# Phase 8 — Subgroup admins (design)

**Status: design and data model only. Nothing enforces scoping yet.**

The `AdminScopeAssignment` schema and model exist (`packages/data-schemas/src/schema/adminScopeAssignment.ts`)
so the shape is settled and reviewable. No query reads it, no route trusts it, and
no UI exposes it. That is deliberate: a scoping boundary that is half-applied is
worse than none, because the console *looks* like it isolates while counts and
aggregates still leak.

Implement in one pass, against the checklist below, or not at all.

## Decisions already made

**One group per administrator, enforced by the database.** The unique partial
index `admin_scope_single_group` on `(tenantId, userId)` where `revokedAt: null`
means an administrator can hold exactly one live assignment. Revoked rows are
excluded so history survives and a re-grant is possible.

**Billing attribution needs no rule.** Because a member can never sit under two
group budgets, no usage event has to choose between them — attribution is
unambiguous by construction. This is why the single-group constraint is a
security decision and not merely a simplification: the alternative (multi-group
membership plus a "primary group" tiebreak) puts a mutable field on the billing
path, and mutable billing attribution cannot be audited.

Consequence to accept: moving a member between groups is a revoke-then-grant, and
usage already recorded stays attributed to the group that owned it at the time.
Historic usage is never reattributed.

## The hard part: the acceptance gate

> A group admin cannot enumerate, infer, export, or mutate users outside assigned
> groups, including through search counts, error messages, config selectors, and
> usage aggregates.

"Infer" is what makes this expensive. Filtering the obvious list endpoint is
perhaps a tenth of the work. Every channel below has to be closed, and each one
is a place where a scoped admin could reconstruct facts about members they do not
administer.

| Channel | Leak if unhandled | Required behaviour |
|---|---|---|
| Member list | Out-of-scope rows returned | Filter by assigned group |
| **Pagination totals** | `total: 214` reveals institution size | Count within scope only |
| **Search** | A hit/miss on an email confirms membership | Search within scope; out-of-scope match must be indistinguishable from no match |
| **Error codes** | `404` vs `403` distinguishes "no such user" from "exists, not yours" | Return the same status for both |
| Seat summary | `activeMembers` is an institution-wide count | Either scope it or withhold it |
| **Usage aggregates** | Institution totals imply other groups' usage by subtraction | Serve group-scoped aggregates only; never institution totals |
| CSV export | Bypasses UI filters entirely | Same scoping as the list, applied server-side |
| CSV import | Inviting into another group is a mutation | Reject rows outside scope |
| Invitations | Inviting is a mutation with a seat side-effect | Scope to assigned group; seat check stays institution-wide |
| Role changes / suspend / remove | Mutation on an out-of-scope member | Reject with the indistinguishable error |
| Config/scope selectors | Group and role pickers enumerate all groups | Restrict options to assigned scope |
| Audit log | Entries name out-of-scope actors and targets | Filter to in-scope targets |

Two further requirements that are easy to miss:

- **Scoping belongs on the server, resolved from the session.** A `groupId`
  accepted from the client is not a boundary. The pattern already used for
  institution admins applies: derive scope from `req.user`, never from a
  parameter.
- **A scoped admin must not be able to grant scope.** Only an institution admin
  (unscoped) or a platform superadmin may create assignments, or a group admin
  could widen their own authority.

## Suggested implementation order

1. `AdminScopeAssignment` methods (grant / revoke / resolve-for-user) plus a
   `resolveAdminScope(req)` helper that returns `null` for unscoped admins.
2. A single server-side scope filter applied in `institutionMembers.js` and
   `institutionUsage.js`, so list, count, search and export share one code path
   and cannot drift apart.
3. Mutation guards returning an identical error for out-of-scope and not-found.
4. Assignment management UI (institution admin only), then the scoped member view.
5. Tests written as the gate is written: for each channel above, one test proving
   an out-of-scope member is indistinguishable from a non-existent one.

## Why this is not urgent

Nothing today needs it. Institution admins are already tenant-scoped, and the
quota engine bills per institution and per member. Subgroup admins matter only
when a single institution wants departments administered independently — no
member university has asked. Phase 9 (production hardening: security review,
load tests, backup drills, alerting) is the higher-value next slice for the
pilot.
