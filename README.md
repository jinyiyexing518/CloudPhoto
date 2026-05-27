# CloudPhoto

A full-stack personal cloud photo storage app with user authentication, JWT refresh tokens, group sharing, folder organisation, and zero-key security via Azure Managed Identity.

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
        │       └── groups   (partition: /id)
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
- **Role system** — global `admin` / `viewer`; per-group `admin` / `member`
- **Private photo space** — personal folders visible only to the owner (admin sees all)
- **Group sharing** — create groups, add members by username, share photos within groups
- **Sub-folder navigation** — nested folders (e.g. `旅游/北京`); breadcrumb navigation; drag-and-drop between folders; extra folders persisted in `localStorage` per context
- **Batch operations** — multi-select mode with batch delete and batch move to folder
- **Multi-photo upload** — select multiple photos at once; sequential upload with per-folder progress (`⏳ 2/5`); partial-failure reporting; client-side MIME type + 20 MB size guard before upload
- **Photo download** — download original file directly from the browser (mobile & desktop)
- **Photo rename** — change the display name of any photo without re-uploading
- **Move photos** — move photos between folders via UI or drag-and-drop
- **Timeline view** — date-grouped photo gallery, newest first
- **Search & filter** — filter by name, subject, uploader, date range
- **Fullscreen modal** — view full details, edit subject / rename / download inline
- **Delete with confirmation** — custom confirm dialog (no browser `alert`)
- **Mobile responsive UI** — 2-column grid, compact header, touch-friendly modals on screens ≤ 680 px
- **Admin tools** — super-admin (configured via `SUPER_ADMIN_USERNAME` env var) can promote other users to admin
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
| `POST`   | `/api/photos/move` | ✓ | Move photo to a different folder |
| `PATCH`  | `/api/photos/metadata?name=<blobName>` | ✓ | Update subject / folder / originalName |
| `DELETE` | `/api/photos?name=<blobName>` | ✓ | Delete a photo by blob name |

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
| `POST`   | `/api/groups/{groupId}/members` | Group admin | Add member by username |
| `DELETE` | `/api/groups/{groupId}/members/{memberId}` | Group admin / self | Remove member |

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

---

## Azure Setup

### Cosmos DB

1. Portal → **Azure Cosmos DB** → **+ Create** → **NoSQL API** → **Serverless** (free tier)
2. Create database `cloudphoto` with three containers:

   | Container | Partition key |
   |-----------|---------------|
   | `users`   | `/id` |
   | `admins`  | `/id` |
   | `groups`  | `/id` |

3. Pre-seed `admins` with an entry for the super-admin:
   ```json
   { "id": "your@email.com", "email": "your@email.com", "username": "yourusername" }
   ```

> All containers are created automatically on first run if they don't exist.

### Azure Blob Storage

1. Create a Storage Account (e.g. `photostorage`)
2. Create a container named `photos` with **Private** access
3. No access keys needed — grant Managed Identity RBAC roles (below)

### Function App Application Settings

| Name | Value |
|------|-------|
| `COSMOS_ENDPOINT` | Cosmos DB URI |
| `COSMOS_DATABASE` | `cloudphoto` |
| `JWT_SECRET` | Random 48-char hex string |
| `STORAGE_ACCOUNT_NAME` | `photostorage` |
| `STORAGE_CONTAINER_NAME` | `photos` |
| `SUPER_ADMIN_USERNAME` | Super-admin username |

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
│   │   └── staticwebapp.config.json  # SPA fallback routing for SWA
│   └── src/
│       ├── App.tsx              # Root component — layout, upload handler, file validation
│       ├── index.css            # Global styles + responsive breakpoints + batch-select UI
│       ├── contexts/
│       │   ├── AuthContext.tsx  # JWT auth state: login / register / logout / token persistence
│       │   └── GroupContext.tsx # Current group selection
│       ├── components/
│       │   ├── auth/
│       │   │   ├── AuthPage.tsx          # Login / Register tab UI
│       │   │   └── AddAdminDialog.tsx    # Promote user to admin
│       │   ├── gallery/
│       │   │   ├── PhotoGallery.tsx      # Date-grouped timeline + batch selection toolbar
│       │   │   ├── FolderView.tsx        # Sub-folder navigation, breadcrumb, drag-drop, batch ops
│       │   │   ├── PhotoCard.tsx         # Thumbnail + selection badge + delete confirmation
│       │   │   └── FilterBar.tsx         # Filter by name / subject / uploader / date range
│       │   └── groups/
│       │       ├── GroupSwitcher.tsx     # Header dropdown: personal / groups
│       │       ├── CreateGroupDialog.tsx # Create group form
│       │       └── GroupSettings.tsx     # Members list + danger zone
│       └── services/
│           ├── photoApi.ts      # API calls with 15s timeout; 401→refresh→retry mutex; token helpers
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
        │   │   ├── movePhoto.ts         # POST   /api/photos/move
        │   │   ├── updatePhotoMetadata.ts  # PATCH /api/photos/metadata (JWT required)
        │   │   └── deletePhoto.ts       # DELETE /api/photos (JWT required)
        │   └── groups/
        │       ├── createGroup.ts       # POST   /api/groups
        │       ├── listGroups.ts        # GET    /api/groups
        │       ├── getGroup.ts          # GET    /api/groups/{groupId}
        │       ├── updateGroup.ts       # PATCH  /api/groups/{groupId}
        │       ├── deleteGroup.ts       # DELETE /api/groups/{groupId}
        │       ├── addMember.ts         # POST   /api/groups/{groupId}/members
        │       └── removeMember.ts      # DELETE /api/groups/{groupId}/members/{memberId}
        └── utils/
            ├── blobStorage.ts   # DefaultAzureCredential + User Delegation SAS (2h)
            ├── cosmosClient.ts  # DefaultAzureCredential + Cosmos DB client
            └── jwtUtils.ts      # signToken (2h) / signRefreshToken (30d) / verify
```
