# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Global Deny-By-Default**: Any path not explicitly matched is denied (`allow read, write: if false;`).
2. **Verified Authentication**: Every read and write requires `request.auth != null && request.auth.token.email_verified == true`.
3. **PII Isolation (`users/{uid}`)**: User documents contain `email` and quota telemetry. Only the authenticated owner (`request.auth.uid == uid`) can `get`, `create`, or `update` their own profile. `list` and `delete` are forbidden on `/users/{uid}`.
4. **Master Gate Relational Sync**:
   - Subcollections (`segments`, `jobs`, `exports`) under `/projects/{projectId}` verify parent project existence and ownership via `get(/databases/$(database)/documents/projects/$(projectId)).data.ownerId == request.auth.uid` on single-document operations (`get`, `create`, `update`, `delete`).
   - On `list` queries, subcollections enforce `resource.data.ownerId == request.auth.uid` directly without `get()` calls to prevent O(N) read cost amplification while strictly preventing cross-tenant query scraping.
5. **Strict Schema & Anti-Update-Gap Blueprints**:
   - Every `create` and `update` is wrapped in `isValid[Entity](incoming())`.
   - Every `create` enforces `hasAll` and `hasOnly` for exact key sets, plus `createdAt == request.time` and `updatedAt == request.time`.
   - Every `update` enforces `incoming().diff(existing()).affectedKeys().hasOnly(...)`, immutability of `ownerId`, `projectId`, `createdAt`, and `updatedAt == request.time`.
6. **ID Poisoning & Volumetric Guards**:
   - Every path parameter is checked with `isValidId(id)` (`<= 128` chars, `^[a-zA-Z0-9_\-]+$`).
   - Every string field has an explicit `.size() <= MAX` bound.
   - `tags` array on `Project` is bounded to `.size() <= 10` and validates element type/length.

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Unverified Email Spoof**: Authenticated user with `email_verified: false` attempts to create a `UserProfile` at `/users/user_1`.
2. **PII Cross-Tenant Read**: User `attacker_uid` attempts `get` on `/users/victim_uid`.
3. **Shadow Field Injection on Project Create**: Owner attempts to create `/projects/proj_1` with an undeclared field `"isAdmin": true`.
4. **Cross-Tenant Project Ownership Spoof**: User `attacker_uid` creates `/projects/proj_1` with `"ownerId": "victim_uid"`.
5. **Immutable Field Mutation (`ownerId` Flip)**: Project owner attempts `update` on `/projects/proj_1` changing `ownerId` to another user.
6. **Timestamp Forgery (Temporal Integrity Violation)**: Project owner attempts `create` on `/projects/proj_1` with a past client timestamp instead of `request.time`.
7. **Denial-of-Wallet Oversized String**: Project owner attempts `update` on `/projects/proj_1/segments/seg_1` with a 5,000-character `text` string (`maxLength: 1000`).
8. **Orphaned Subcollection Write**: Authenticated user attempts `create` on `/projects/nonexistent_proj/segments/seg_1` where parent project does not exist.
9. **Cross-Tenant Subcollection Write (Master Gate Breach)**: User `attacker_uid` attempts `update` on `/projects/victim_proj/segments/seg_1`.
10. **Unbounded Tag Array Attack**: Project owner attempts `create` on `/projects/proj_1` with 25 elements in `tags` (`max: 10`).
11. **Value Poisoning on Update**: Project owner updates whitelisted key `status` on `/projects/proj_1` with `"status": "hacked_status"` (outside enum).
12. **Unauthorized Template Mutation**: User `attacker_uid` attempts `update` on public template `/templates/tpl_1` owned by `victim_uid`.
