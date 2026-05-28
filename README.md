# CloudPhoto

A full-stack personal cloud photo storage app with user authentication, JWT refresh tokens, group sharing, folder organisation, and zero-key security via Azure Managed Identity.

For end users, see: [USER_GUIDE.md](USER_GUIDE.md)

**Frontend:** React 18 + Vite 5 → deployed to **Azure Static Web Apps**  
**Backend:** Azure Functions v4 (Node.js 24, TypeScript) → deployed to **Azure Functions** (`cloudphoto-api`)  
**Storage:** Azure Blob Storage (`photostorage` / `photos`) — accessed via **User Delegation SAS** (no account key)  
**Database:** Azure Cosmos DB NoSQL (`cloudphoto`) — accessed via **Managed Identity** (no connection string key)

---

## Architecture

```text
brave-sand-053b07a00.7.azurestaticapps.net   ← Azure Static Web Apps (frontend)
        │
        │  HTTPS + CORS
        ▼
cloudphoto-api.azurewebsites.net/api/*       ← Azure Functions v4 (backend)
        │
        ├── Azure Cosmos DB NoSQL (cloudphoto)
        │       ├── users    (partition: /id)
        │       ├── admins   (partition: /id)
        │       ├── groups   (partition: /id)
        │       ├── invites  (partition: /id)
        │       ├── sharelinks (partition: /id)
        │       └── moments (partition: /id)
        │
        └── Azure Blob Storage (photostorage / photos)
                └── Time-limited User Delegation SAS (2h, keyless)
```

For local development, Vite proxies all `/api/*` requests to `localhost:7071`, so no
URL changes are needed between dev and prod — the frontend reads `VITE_API_BASE` at
build time (defaults to `/api`).

---

## Features

- **JWT auth with auto-refresh** — 2-hour access tokens + 30-day rotating refresh tokens; on 401 the client silently refreshes and retries the original request; concurrent 401s share a single in-flight refresh (mutex)
- **Auth rate limiting** — in-memory sliding-window per IP: login 10 req/min, register 5 req/min, refresh 20 req/min; over-limit returns `429 + Retry-After: 60`
- **Delegation key caching** — Azure User Delegation Key cached in-process and reused while > 10 min validity remains, eliminating one control-plane call per photo-list request
- **Role system** — global `admin` / `viewer`; per-group `admin` / `member`
- **Private photo space** — personal folders visible only to the owner (admin sees all)
- **Group sharing** — create groups and invite members by username or email address; all additions go through an email invite flow — the recipient must accept the invite link before joining; invites expire after 7 days and can be cancelled by the group admin
- **Sub-folder navigation** — nested folders (e.g. `旅游/北京`); breadcrumb navigation; drag-and-drop between folders; extra folders persisted in `localStorage` per context
- **Folder back-stack behavior** — in folder view, browser/device back navigates up folder levels before exiting the app
- **Folder back-stack integration** — while browsing folders, system/browser back first returns to previous folder levels instead of closing the app directly
- **Session persistence** — last-used group space and current folder path are remembered in `localStorage` per user; page refresh returns you exactly where you were
- **Recycle bin** — deleting a photo soft-deletes it (blob metadata `deletedAt`); a dedicated 🗑️ Trash tab lets you restore photos to their original folder or permanently delete them; "清空回收站" bulk-deletes all
- **Mobile sticky trash actions** — on small screens, restore and permanent-delete actions are pinned to a sticky bottom bar for one-hand operation
- **Batch operations** — multi-select mode with batch delete and batch move to folder
- **Multi-photo upload** — select multiple photos at once; sequential upload with per-folder progress (`⏳ 2/5`); partial-failure reporting; client-side MIME type + 20 MB size guard before upload
- **Photo download** — download original file directly from the browser (mobile & desktop)
- **Expiring share links** — generate per-photo public read links with configurable TTL (1h / 24h / 3d / 7d)
- **One-click share copy** — share URL copy uses Clipboard API first, then legacy copy fallback; only falls back to manual copy prompt as a last resort
- **Managed share links (cloud)** — in Settings you can revoke links early or extend expiry, with per-link status and lifecycle maintained on the backend
- **Managed share filters** — cloud share links support server-side filtering by status (`active` / `expired` / `revoked`) and fuzzy search by filename
- **Flexible share extension** — managed links can be extended with selectable presets (1h / 24h / 3d / 7d / 30d) instead of fixed 24h only
- **Share analytics** — every managed share link records createdAt, viewCount, and lastViewedAt for operation visibility
- **Automatic expiry reconciliation** — while listing managed links, backend auto-normalizes time-expired active links to `expired` for accurate status display
- **Optimistic concurrency safety** — metadata update / move / delete / restore / share maintenance all use conditional writes (ETag + retry) to prevent concurrent overwrite
- **Unified conflict UX** — when backend returns `409` conflict, frontend shows a consistent toast message (`资源已被他人修改，请刷新后重试`)
- **Share link manager (local)** — the Settings → 📱 应用 tab shows recent valid share links with one-click copy/open/delete and one-click clear
- **Photo rename** — change the display name of any photo without re-uploading
- **Move photos** — move photos between folders via UI or drag-and-drop
- **Timeline view** — date-grouped photo gallery, newest first
- **Timeline memory highlights** — automatically surfaces "历史回忆" photos from the same month/day in previous years
- **Important moments tab** — moments are ranked by engagement and shown in a dedicated ⭐ tab with independent filters and sort modes
- **Moments cross-device analytics** — open/navigate in moments records views to backend (Cosmos), including total views, last viewed time, top viewer, and peak day
- **Moments details focus** — moments modal details focus on recommendation score + engagement metrics (not timeline-style upload/modify metadata)
- **Timeline pagination** — timeline initially loads the newest page and can load more progressively to keep first paint fast
- **Search & filter** — filter by name, subject, uploader, date range
- **Fullscreen modal** — view full details, edit subject / rename / download inline
- **Long-filename-safe modal layout** — very long file names are truncated with ellipsis and will not overlap or hide action buttons such as rename
- **Modal keyboard navigation** — ← / → keys to step through photos in a folder or timeline; Esc to close; prev/next buttons for mouse/touch; available in both Timeline and Folder views
- **Toast notification system** — lightweight React-Context toast queue (success / error / info); auto-dismisses after 3.5 s; replaces all inline error banners
- **Image shimmer skeleton** — animated shimmer placeholder shown while each photo thumbnail loads; fades in on completion to eliminate layout shift
- **Active filter chips** — applied subject / uploader / date filters shown as dismissible pill chips below the search bar for at-a-glance visibility
- **Debounced name search** — 300 ms debounce on the name filter prevents unnecessary re-renders while typing
- **Select All / Deselect All** — one-click toggle in batch mode for both Timeline and Folder views
- **Batch delete confirmation dialog** — explicit confirm step before bulk deleting photos in both views
- **Parallel batch move** — folder batch-move fires all move requests concurrently with `Promise.all`, replacing the previous sequential loop
- **Loading spinner** — animated CSS spinner replaces static "Loading photos…" text during photo fetch
- **Retry button** — load-error state shows a "重试" button allowing users to re-fetch without refreshing the page
- **Rich empty state** — photo icon + bilingual message when no photos exist, replacing the bare English placeholder
- **Delete with confirmation** — custom confirm dialog (no browser `alert`)
- **Mobile responsive UI** — 2-column grid, compact header, touch-friendly modals on screens ≤ 680 px
- **Admin tools** — super-admin (configured via `SUPER_ADMIN_USERNAME` env var) can promote other users to admin
- **PWA app mode** — installable as an app on desktop/mobile (manifest + service worker + update prompt)
- **Dev refresh stability** — local Vite dev mode disables SW registration by default to avoid development-time refresh loops
- **Dev refresh stability** — PWA service worker registration is disabled in Vite dev mode to avoid local development refresh loops
- **Transfer safety guard** — while upload/download is in progress, tab switching is blocked and browser refresh/close shows unload confirmation
- **Keyless security** — no storage account keys or Cosmos DB keys anywhere; `DefaultAzureCredential` (Managed Identity on Azure, Azure CLI locally)
- **CI/CD** — GitHub Actions with OIDC authentication (no stored passwords); separate workflows for frontend and backend, triggered only on relevant path changes

---

## Role System

| Role | Permissions |
|------|-------------|
| `admin` | Sees all photos (private + all groups). Can add admins. |
| `viewer` | Sees own private photos + photos in joined groups only. |

Within a group:

| Group Role | Permissions |
|------------|-------------|
| `admin` | Add / remove members, update or delete the group |
| `member` | View and upload photos to the group |

Only the super-admin (configured via `SUPER_ADMIN_USERNAME` env var) can promote users to global `admin`.

---

## Data Model

### UserDoc (`users` container)
```jsonc
{
  "id": "<uuid>",
  "username": "alice",
  "email": "alice@example.com",
  "displayName": "Alice",
  "passwordHash": "<bcrypt, cost 10>",
  "role": "admin" | "viewer",
  "privateFolders": ["Holidays", "Work"],
  "createdAt": "2025-01-01T00:00:00Z",
  "lastLoginAt": "2025-06-01T12:00:00Z"
}
```

### GroupDoc (`groups` container)
```jsonc
{
  "id": "<uuid>",
  "name": "Family Trip",
  "description": "Summer 2025",
  "createdBy": "<userId>",
  "createdAt": "2025-06-01T00:00:00Z",
  "members": [
    { "userId": "...", "username": "alice", "email": "...",
      "displayName": "Alice", "role": "admin",
      "joinedAt": "...", "addedBy": "..." }
  ],
  "folders": ["Arrival", "Beach", "Farewell"]
}
```

### InviteDoc (`invites` container)
```jsonc
{
  "id": "<uuid token>",        // also the partition key; sent in the invite link
  "groupId": "<uuid>",
  "groupName": "Family Trip",
  "email": "bob@example.com",  // lowercase; must match the recipient's account email
  "invitedByUserId": "<uuid>",
  "invitedByName": "Alice",
  "status": "pending",         // pending | accepted | declined | cancelled
  "createdAt": "2025-06-01T00:00:00Z",
  "expiresAt": "2025-06-08T00:00:00Z",  // 7 days after creation
  "respondedAt": "2025-06-02T10:00:00Z"  // set on accept / decline
}
```

### MomentInsightDoc (`moments` container)
```jsonc
{
  "id": "moment:<base64(photoName)>",
  "photoName": "personal/<userId>/<folder>/<file>",
  "scopeType": "personal" | "group",
  "scopeId": "<userId or groupId>",
  "totalViews": 12,
  "lastViewedAt": "2026-05-28T09:30:00Z",
  "lastViewedBy": "Alice",
  "viewers": { "Alice": 9, "Bob": 3 },
  "dailyViews": { "2026-05-27": 4, "2026-05-28": 8 },
  "createdAt": "2026-05-25T10:00:00Z",
  "updatedAt": "2026-05-28T09:30:00Z"
}
```

Moments scoring model used by the frontend:

$$
(\text{recommendationScore}) =
(\text{favorite}?120:0)
+(\text{subject}?20:0)
+\max(0, 40-\text{recencyDays})
$$

$$
(\text{engagementScore}) =
(\text{recommendationScore})
+24\times\text{totalViews}
+\text{recentViewBoost(0..72h)}
$$

### Blob Metadata (per photo in Azure Blob Storage)
```
originalName    base64-encoded original filename
subject         optional subject / caption
folder          folder name (empty = uncategorised)
groupId         group this photo belongs to (empty = private)
createdBy       uploader display name
createdById     uploader userId
createdAt       ISO 8601 timestamp
lastModifiedBy  display name of last editor
lastModifiedAt  ISO 8601 timestamp
```

---

## API Reference

All protected routes require `Authorization: Bearer <accessToken>`.

### Auth

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/auth/register` | — | Register; returns `{ token, refreshToken, user }` |
| `POST` | `/api/auth/login` | — | Login; returns `{ token, refreshToken, user }` |
| `GET`  | `/api/auth/me` | ✓ | Get current user info |
| `POST` | `/api/auth/refresh` | Refresh token | Exchange refresh token for new access + refresh tokens (rotating) |
| `POST` | `/api/auth/admins` | Admin only | Promote a user to admin |

### Photos

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET`    | `/api/photos[?groupId=<id>]` | ✓ | List photos; each URL is a 2-hour User Delegation SAS |
| `POST`   | `/api/photos/upload?filename=<name>[&folder=<path>][&groupId=<id>]` | ✓ | Upload (raw binary body); rejects non-image MIME (415) and > 20 MB (413) |
| `GET`    | `/api/photos/download?name=<blobName>` | ✓ | Proxy-download with `Content-Disposition: attachment` |
| `GET`    | `/api/photos/share?name=<blobName>&hours=<1..168>` | ✓ | Create expiring share link (`{ url, expiresAt }`) |
| `GET`    | `/api/photos/share/open/{linkId}` | — | Open managed public share link (redirects to a short-lived SAS and increments view stats) |
| `GET`    | `/api/photos/share/links[?status=active|expired|revoked&q=<keyword>]` | ✓ | List current user's managed share links with optional status/name filtering |
| `PATCH`  | `/api/photos/share/links/{linkId}` | ✓ | Revoke now (`action=revoke`) or extend expiry (`action=extend`, `hours=1..720`); conflict returns `409` |
| `GET`    | `/api/photos/moments/insights?name=<photoName>&name=<photoName...>` | ✓ | Batch query moments analytics for specified photos (cross-device persisted) |
| `POST`   | `/api/photos/moments/view` | ✓ | Record one moments view (`photoName`, optional `viewerName`) with optimistic concurrency |
| `POST`   | `/api/photos/move` | ✓ | Move photo to a different folder |
| `PATCH`  | `/api/photos/metadata?name=<blobName>` | ✓ | Update subject / folder / originalName; conflict returns `409` |
| `DELETE` | `/api/photos?name=<blobName>` | ✓ | Soft-delete a photo by blob name; conflict returns `409` |

**`GET /api/photos` ownership rules:**
- `?groupId=<id>` — requester must be a member of that group
- No `groupId` — returns requester's private photos (admin sees all private photos)

### Groups

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST`   | `/api/groups` | ✓ | Create a group (creator becomes group admin) |
| `GET`    | `/api/groups` | ✓ | List groups the user belongs to |
| `GET`    | `/api/groups/{groupId}` | Member | Get group details + members |
| `PATCH`  | `/api/groups/{groupId}` | Group admin | Update name / description |
| `DELETE` | `/api/groups/{groupId}` | Group admin | Delete the group |
| `POST`   | `/api/groups/{groupId}/members` | Group admin | Invite by **username** — looks up the user's email and creates an invite (returns 202, not added until accepted) |
| `DELETE` | `/api/groups/{groupId}/members/{memberId}` | Group admin / self | Remove member |

### Invites

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST`   | `/api/groups/{groupId}/invites` | Group admin | Send email invite by **email address**; creates `InviteDoc`, emails accept link |
| `GET`    | `/api/groups/{groupId}/invites` | Group admin | List pending invites for the group |
| `GET`    | `/api/invites/{token}` | — (public) | Get invite info (used by accept page); 410 if expired |
| `POST`   | `/api/invites/{token}/respond` | ✓ (email must match) | Accept or decline; on accept, adds user to group |
| `DELETE` | `/api/invites/{token}` | Group admin | Cancel a pending invite |

> Both `/api/groups/{groupId}/members` (username) and `/api/groups/{groupId}/invites` (email) use the same invite flow: no one is added to a group without explicitly accepting an invite link.

---

## Authentication Flow

### Registration / Login
1. Client sends credentials; server responds with `{ token, refreshToken, user }`
2. `token` — HS256 JWT, **2-hour** expiry, contains `{ userId, username, displayName, role }`
3. `refreshToken` — HS256 JWT, **30-day** expiry, carries an additional `tokenType: "refresh"` claim
4. Both tokens stored in `localStorage`

### Silent Token Refresh
1. Any API call that receives **HTTP 401** triggers `getRefreshedToken()`
2. `getRefreshedToken()` is a **mutex** — if multiple concurrent requests all 401 at once, only one `POST /api/auth/refresh` call goes out; all waiters receive the same new token
3. The original request is **retried once** with the new token, transparently to calling code
4. If the refresh token itself is expired, the user is redirected to login
5. Refresh tokens are **rotated** on every use (30-day window slides forward)

### Session Restore (on page reload)
1. App reads `cloudphoto_token` from `localStorage`
2. Calls `GET /api/auth/me` to validate and restore user state
3. If the access token expired between page loads, the first API call triggers silent refresh

---

## Local Development

### Prerequisites

- Node.js 24+
- Yarn (`npm install -g yarn`)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Azure CLI (`az login` — used by `DefaultAzureCredential` locally)

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

### Setup

**1. Clone and install**

```bash
git clone https://github.com/jinyiyexing518/CloudPhoto.git
cd CloudPhoto
```

**2. Configure backend secrets** — create `server/local.settings.json` (git-ignored):

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "STORAGE_ACCOUNT_NAME": "<your storage account name>",
    "STORAGE_CONTAINER_NAME": "photos",
    "COSMOS_ENDPOINT": "https://<your-cosmos>.documents.azure.com:443/",
    "COSMOS_DATABASE": "cloudphoto",
    "JWT_SECRET": "<random 48-char hex string>",
    "SUPER_ADMIN_USERNAME": "<your username>"
  },
  "Host": { "CORS": "*" }
}
```

> **No storage or Cosmos keys required.** The backend uses [Managed Identity / DefaultAzureCredential](https://learn.microsoft.com/azure/developer/javascript/sdk/authentication/overview).
> Locally, `DefaultAzureCredential` falls back to your **Azure CLI session** — run `az login` once and you're done.

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

For local development, grant your own Azure AD identity the roles below:

```bash
# Storage: Blob Data Contributor + Blob Delegator
az role assignment create --assignee <YOUR_PRINCIPAL_ID> \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Storage/storageAccounts/<STORAGE>

az role assignment create --assignee <YOUR_PRINCIPAL_ID> \
  --role "Storage Blob Delegator" \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Storage/storageAccounts/<STORAGE>

# Cosmos DB: Built-in Data Contributor
az cosmosdb sql role assignment create \
  --account-name <COSMOS_ACCOUNT> --resource-group <RG> \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id <YOUR_PRINCIPAL_ID> \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.DocumentDB/databaseAccounts/<COSMOS_ACCOUNT>
```

**3. Run locally**

```bash
# Terminal 1 — Backend
cd server && yarn && yarn start   # func start on localhost:7071

# Terminal 2 — Frontend
cd client && yarn && yarn dev     # Vite on localhost:3000 (proxies /api → :7071)
```

Open [http://localhost:3000](http://localhost:3000).

### Feature Folder Convention

- Client share feature utilities are grouped under `client/src/features/share/`.
- Server share-related HTTP functions are grouped under `server/src/functions/share/`.
- Keep new cross-cutting features grouped by domain to avoid scattering logic under generic folders.

---

## Azure Setup

### Cosmos DB

1. Portal → **Azure Cosmos DB** → **+ Create** → **NoSQL API** → **Serverless** (free tier)
2. Create database `cloudphoto` with these containers:

   | Container | Partition key |
   |-----------|---------------|
   | `users`   | `/id` |
   | `admins`  | `/id` |
   | `groups`  | `/id` |
   | `invites` | `/id` |

3. Pre-seed `admins` with an entry for the super-admin:
   ```json
   { "id": "your@email.com", "email": "your@email.com", "username": "yourusername" }
   ```

> All containers are created automatically on first run if they don't exist.

### Azure Blob Storage

1. Create a Storage Account (e.g. `photostorage`)
2. Create a container named `photos` with **Private** access
3. No access keys needed — grant Managed Identity RBAC roles (below)
4. If share links must open on public internet, Storage Account networking must allow public access (or equivalent routed access). Private-endpoint-only storage will make copied share links unreachable outside private network.

### Function App Application Settings

| Name | Value |
|------|-------|
| `COSMOS_ENDPOINT` | Cosmos DB URI |
| `COSMOS_DATABASE` | `cloudphoto` |
| `JWT_SECRET` | Random 48-char hex string |
| `STORAGE_ACCOUNT_NAME` | `photostorage` |
| `STORAGE_CONTAINER_NAME` | `photos` |
| `SUPER_ADMIN_USERNAME` | Super-admin username |
| `ACS_ENDPOINT` | Azure Communication Services endpoint URL — used with Managed Identity (recommended for production, e.g. `https://<name>.communication.azure.com/`) |
| `ACS_CONNECTION_STRING` | ACS connection string — fallback for local dev when Managed Identity is not available |
| `ACS_SENDER_ADDRESS` | Verified sender address for ACS email (e.g. `DoNotReply@<uuid>.azurecomm.net`) |
| `APP_BASE_URL` | Public URL of the app, embedded in invite links (e.g. `https://yourapp.azurestaticapps.net`) |

> **Email invites via Managed Identity:** set `ACS_ENDPOINT` (not `ACS_CONNECTION_STRING`) in production and grant the Function App's Managed Identity the **Communication Services Contributor** role on your ACS resource. `ACS_CONNECTION_STRING` is only needed for local development.

> `STORAGE_ACCOUNT_KEY` and `COSMOS_KEY` are **not needed** — the Function App uses Managed Identity.

---

## Managed Identity & RBAC Setup

The backend uses `DefaultAzureCredential`. No secrets are stored for storage or database access.

### 1. Enable System-assigned Managed Identity

Portal → `cloudphoto-api` → **Identity** → **System assigned** → toggle **On** → **Save**.

### 2. Grant Storage roles

```bash
MI_PRINCIPAL=<Object ID from Identity blade>
STORAGE_SCOPE=/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Storage/storageAccounts/photostorage

az role assignment create --assignee $MI_PRINCIPAL \
  --role "Storage Blob Data Contributor" --scope $STORAGE_SCOPE

az role assignment create --assignee $MI_PRINCIPAL \
  --role "Storage Blob Delegator" --scope $STORAGE_SCOPE
```

### 3. Grant Cosmos DB role

```bash
az cosmosdb sql role assignment create \
  --account-name <COSMOS_ACCOUNT> --resource-group <RG> \
  --role-definition-id 00000000-0000-0000-0000-000000000002 \
  --principal-id $MI_PRINCIPAL \
  --scope /subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.DocumentDB/databaseAccounts/<COSMOS_ACCOUNT>
```

### 4. Grant Azure Communication Services role (for email invites)

```bash
ACS_SCOPE=/subscriptions/<SUB>/resourceGroups/<RG>/providers/Microsoft.Communication/communicationServices/<ACS_NAME>

az role assignment create --assignee $MI_PRINCIPAL \
  --role "Communication Services Contributor" --scope $ACS_SCOPE
```

> Set `ACS_ENDPOINT` (the ACS resource URL) and `ACS_SENDER_ADDRESS` in the Function App's Application Settings. No connection string key is required.

---

## CI/CD (GitHub Actions)

Two workflows run automatically on push to `main`:

| Workflow | File | Trigger |
|----------|------|---------|
| Deploy Backend | `.github/workflows/deploy-backend.yml` | `server/**` changed |
| Deploy Frontend | `.github/workflows/deploy-frontend.yml` | `client/**` changed |

Both use **OIDC authentication** (no stored Azure passwords/keys).

### Required GitHub Secrets

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | Service principal Application ID |
| `AZURE_TENANT_ID` | Azure Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `AZURE_FUNCTIONAPP_NAME` | `cloudphoto-api` |
| `AZURE_RESOURCE_GROUP` | `CloudPhoto` |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA deployment token |
| `VITE_API_BASE` | `https://cloudphoto-api.azurewebsites.net/api` |

---

## PWA Install Guide

The frontend is installable as a PWA and can run in both browser mode and app mode.

### Desktop (Chrome / Edge)

1. Open the production site over HTTPS
2. Click the install icon in the address bar (or browser menu -> Install app)
3. Launch from desktop/start menu as a standalone app window

### Android (Chrome)

1. Open the production site over HTTPS
2. Browser menu -> Install app / Add to Home screen

### iOS (Safari)

1. Open the production site in Safari
2. Tap Share
3. Tap Add to Home Screen

> iOS does not fire `beforeinstallprompt`, so in-app install buttons may not appear there.

### OIDC Service Principal Setup

```bash
az ad sp create-for-rbac \
  --name "cloudphoto-github" \
  --role contributor \
  --scopes /subscriptions/<SUB_ID>/resourceGroups/CloudPhoto \
  --sdk-auth

az ad app federated-credential create \
  --id <APP_ID> \
  --parameters '{
    "name": "github-actions",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:jinyiyexing518/CloudPhoto:ref:refs/heads/main",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

---

## Project Structure

```text
CloudPhoto/
├── .github/workflows/
│   ├── deploy-backend.yml       # Build TypeScript, zip deploy via az CLI (OIDC)
│   └── deploy-frontend.yml      # Build Vite, deploy to Azure Static Web Apps (OIDC)
│
├── client/                      # React 18 + Vite 5
│   ├── public/
│   │   ├── favicon.svg
│   │   ├── apple-touch-icon.svg
│   │   ├── pwa-192x192.svg
│   │   ├── pwa-512x512.svg
│   │   └── maskable-icon.svg
│   ├── staticwebapp.config.json  # SPA fallback routing for SWA
│   └── src/
│       ├── App.tsx              # Root component — layout, transfer guard, PWA install/update hints
│       ├── index.css            # Global styles + responsive breakpoints + batch-select UI
│       ├── contexts/
│       │   ├── AuthContext.tsx  # JWT auth state: login / register / logout / token persistence
│       │   ├── GroupContext.tsx # Current group selection
│       │   └── ToastContext.tsx # Toast notification queue (success / error / info)
│       ├── components/
│       │   ├── auth/
│       │   │   ├── AuthPage.tsx          # Login / Register tab UI
│       │   │   └── AddAdminDialog.tsx    # Promote user to admin
│       │   ├── gallery/
│       │   │   ├── PhotoGallery.tsx      # Date-grouped timeline + batch selection + expiring share links
│       │   │   ├── FolderView.tsx        # Sub-folder navigation, breadcrumb, drag-drop, batch ops, share links
│       │   │   ├── TrashView.tsx         # Recycle bin — restore or permanently delete
│       │   │   ├── PhotoCard.tsx         # Thumbnail + selection badge + delete confirmation
│       │   │   └── FilterBar.tsx         # Filter by name / subject / uploader / date range
│       │   └── groups/
│       │       ├── GroupSwitcher.tsx     # Header dropdown: personal / groups
│       │       ├── CreateGroupDialog.tsx # Create group form
│       │       └── GroupSettings.tsx     # Members list + danger zone
│       └── services/
│           ├── photoApi.ts      # API calls with 15s timeout; 401→refresh→retry mutex; share-link/download helpers
│           └── groupApi.ts      # Group CRUD API calls
│
└── server/                      # Azure Functions v4 (Node.js 24 + TypeScript)
    └── src/
        ├── index.ts             # Imports all function modules
        ├── functions/
        │   ├── auth/
        │   │   ├── authRegister.ts      # POST /api/auth/register
        │   │   ├── authLogin.ts         # POST /api/auth/login (returns refreshToken)
        │   │   ├── authMe.ts            # GET  /api/auth/me
        │   │   ├── authRefresh.ts       # POST /api/auth/refresh (rotating refresh tokens)
        │   │   └── authAddAdmin.ts      # POST /api/auth/admins
        │   ├── photos/
        │   │   ├── listPhotos.ts        # GET    /api/photos (shared delegation key)
        │   │   ├── uploadPhoto.ts       # POST   /api/photos/upload (MIME + size guard)
        │   │   ├── downloadPhoto.ts     # GET    /api/photos/download
        │   │   ├── createShareLink.ts   # GET    /api/photos/share (expiring URL)
        │   │   ├── movePhoto.ts         # POST   /api/photos/move
        │   │   ├── updatePhotoMetadata.ts  # PATCH /api/photos/metadata (JWT required)
        │   │   └── deletePhoto.ts       # DELETE /api/photos (JWT required)
        │   ├── trash/
        │   │   ├── listTrash.ts         # GET    /api/photos/trash
        │   │   ├── restorePhoto.ts      # POST   /api/photos/trash/restore
        │   │   └── deleteTrashItem.ts   # DELETE /api/photos/trash
        │   └── groups/
        │       ├── createGroup.ts       # POST   /api/groups
        │       ├── listGroups.ts        # GET    /api/groups
        │       ├── getGroup.ts          # GET    /api/groups/{groupId}
        │       ├── updateGroup.ts       # PATCH  /api/groups/{groupId}
        │       ├── deleteGroup.ts       # DELETE /api/groups/{groupId}
        │       ├── addMember.ts         # POST   /api/groups/{groupId}/members
        │       └── removeMember.ts      # DELETE /api/groups/{groupId}/members/{memberId}
        │   └── invites/
        │       ├── createInvite.ts      # POST   /api/groups/{groupId}/invites
        │       ├── getInvite.ts         # GET    /api/invites/{token}
        │       ├── respondInvite.ts     # POST   /api/invites/{token}/respond
        │       ├── listGroupInvites.ts  # GET    /api/groups/{groupId}/invites
        │       └── cancelInvite.ts      # DELETE /api/invites/{token}
        └── utils/
            ├── blobStorage.ts   # DefaultAzureCredential + User Delegation SAS (2h)
            ├── cosmosClient.ts  # DefaultAzureCredential + Cosmos DB client
            ├── jwtUtils.ts      # signToken (2h) / signRefreshToken (30d) / verify
            └── rateLimit.ts     # In-memory sliding-window rate limiter (per IP)
```
