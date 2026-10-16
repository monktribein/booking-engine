# Partner onboarding

How a property business joins Tirvona, what it may do at each stage, and how the platform team runs it.

## 1. Lifecycle of a partner (organization)

| Status | How it is reached | What the partner can do |
| --- | --- | --- |
| `PENDING_APPROVAL` | Self-registration (when `PARTNER_APPROVAL_REQUIRED=true`, the default) | Use the PMS privately: properties, rooms, rates, inventory, manual bookings, staff. **Cannot** publish a booking page, request marketplace listing, create API keys or webhooks, or request channel integrations (`403 ORGANIZATION_NOT_APPROVED`). |
| `ACTIVE` | Approved by a platform admin | Everything below. |
| `REJECTED` | Rejected with a reason | Can only sign in to read the reason (`/auth/me`, `/organizations/me`, logout). |
| `SUSPENDED` | Suspended by a super admin | Locked out immediately: sessions, API keys and webhooks stop, public pages disappear. Existing bookings are **not** cancelled; reactivation restores everything. |
| `ARCHIVED` | Retired | Same as suspended. |

Set `PARTNER_APPROVAL_REQUIRED=false` only for internal/dev environments; registrations are then `ACTIVE` at once.
Organizations that existed before the approval feature were marked `ACTIVE` by migration `0002`.

## 2. Steps for a partner

1. **Register** at `/register`. You become the organization's `PROPERTY_OWNER`.
2. **Set up privately** while pending: add a property, room types, rate plans, inventory, staff.
3. **Wait for approval.** A banner shows the status; rejection shows the reason.
4. **Choose where the property is bookable** (Settings → *Visibility & Marketplace*, owners only):
   * *Own booking page* (`direct_booking_enabled`): `/stays/<slug>` and checkout for your own guests.
   * *Tirvona marketplace*: you give explicit consent; the request goes to the platform (`REQUESTED`), which approves or rejects it. Only `APPROVED` properties appear in marketplace search. You can withdraw at any time.
   * A property that is not `ACTIVE`, or is platform-`SUSPENDED`, is bookable nowhere, whatever these settings say.
5. **Connect software** (Settings → *Developers*, or the *Developers* page): create keys with the minimum scopes, add webhook endpoints, use *Send test*, watch delivery history and health. See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md).
6. **Channels**: submit an integration request (Channel Manager). Approval is a record that you may proceed; it does not connect anything — see [CHANNEL_ADAPTERS.md](CHANNEL_ADAPTERS.md).

## 3. Roles

| Role | Scope | Notable rights |
| --- | --- | --- |
| `SUPER_ADMIN` | Platform | Everything, including suspending partners/properties/listings and reading the audit log. |
| `OPERATIONS_ADMIN` | Platform | Approve/reject partners, marketplace listings and integration requests; see operations. No suspension, no audit log, no guest details. |
| `PROPERTY_OWNER` | Organization | Everything for the organization incl. visibility, API keys, webhooks, members. |
| `PROPERTY_MANAGER` | Properties | Day-to-day management; no marketplace consent, keys or org settings. |
| `STAFF` / `RECEPTION` | Properties | Bookings, guests, check-in/out as permitted. |
| `DEVELOPER` | Organization | API keys and webhooks only; no guest, payment or property operations. Invited by the owner. |

Platform staff never see another partner's guest contact details in the admin console; the Operations page lists failures, queues and counts only.

## 4. Platform admin runbook

Create the first admin (never through the public API):

```
cd backend
ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" npm run admin:create      # production: prompts/reads ADMIN_PASSWORD from env
```

(`npm run admin:create:dev` is the local variant.) Then sign in and you land on `/admin`:

* **Partners** — approve / reject (reason required) / suspend / reactivate; open a partner to see people and properties.
* **Marketplace** — review `REQUESTED` listings; approve or reject with a note the owner sees; super admin can suspend/reinstate.
* **Integrations** — decide channel requests; remember approval ≠ connected.
* **Operations** — queue counts, failed syncs and inbound webhooks with retry buttons.
* **Audit log** (super admin) — every decision, append-only.

Each decision is written to the audit log (`admin.*`) and shown to the partner.

## 5. Access revocation

* Remove a user: Settings → Users; sessions end on the next refresh.
* Revoke an API key: immediate on the next request. Rotate with a grace period for zero-downtime swaps.
* Suspend a partner: blocks users, keys and webhooks and hides all properties from public search and checkout.
