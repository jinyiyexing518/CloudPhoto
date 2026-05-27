# CloudPhoto

A personal cloud photo storage app with user authentication, group sharing, and folder-based organisation.

**Frontend:** React 18 + Vite 5 → deployed to **Azure Static Web Apps**  
**Backend:** Azure Functions v4 (Node.js 24, TypeScript) → deployed to **Azure Functions** (`cloudphoto-api`)  
**Storage:** Azure Blob Storage (`photostorage` / `photos`)  
**Database:** Azure Cosmos DB NoSQL (`cloudphoto`)

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
```

For local development, Vite proxies all `/api/*` requests to `localhost:7071`, so no
URL changes are needed between dev and prod — the frontend reads `VITE_API_BASE` at
build time (defaults to `/api`).

---

## Features

- **User authentication** — register / login / logout with JWT (7-day expiry)
- **Role system** — global `admin` / `viewer`; per-group `admin` / `member`
- **Private photo space** — personal folders visible only to the owner (admin sees all)
- **Group sharing** — create groups, add members by username, share photos within groups
- **Sub-folder navigation** — nested folders (e.g. `旅游/北京`); breadcrumb navigation in folder view; drag-and-drop between folders
- **Multi-photo upload** — select multiple photos at once; sequential upload with per-folder progress indicator (`⏳ 2/5`); partial-failure reporting
- **Photo download** — download original file directly from the browser (mobile & desktop)
- **Photo rename** — change the display name of any photo without re-uploading
- **Move photos** — move photos between folders via UI or drag-and-drop
- **Timeline view** — date-grouped photo gallery, newest first
- **Search & filter** — filter by name, subject, uploader, date range
- **Fullscreen modal** — view full details, edit subject / rename / download inline
- **Delete with confirmation** — custom confirm dialog (no browser `alert`)
- **Mobile responsive UI** — 2-column grid, compact header, touch-friendly modals on screens ≤ 680 px
- **Admin tools** — super-admin (`zhangchi`) can promote other users to admin

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

Only the super-admin (`zhangchi` / `2820396830@qq.com`) can promote users to global `admin`.

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

All protected routes require `Authorization: Bearer <token>`.

### Auth

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/auth/register` | — | Register a new user |
| `POST` | `/api/auth/login` | — | Login, returns JWT |
| `GET`  | `/api/auth/me` | ✓ | Get current user info |
| `POST` | `/api/auth/admins` | Admin only | Promote a user to admin |

### Photos

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET`    | `/api/photos[?groupId=<id>]` | ✓ | List photos (scoped by group or private) |
| `POST`   | `/api/photos/upload?filename=<name>[&folder=<path>][&groupId=<id>]` | ✓ | Upload photo (raw binary body, Content-Type = MIME type); `folder` supports nested paths with `/` |
| `GET`    | `/api/photos/download?name=<blobName>` | ✓ | Proxy-download blob with `Content-Disposition: attachment` |
| `POST`   | `/api/photos/move` | ✓ | Move photo to a different folder |
| `PATCH`  | `/api/photos/metadata?name=<blobName>` | ✓ | Update subject / folder / originalName / updatedBy |
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

## Local Development

### Prerequisites

- Node.js 24+
- Yarn (`npm install -g yarn`)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)

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
    "STORAGE_ACCOUNT_KEY": "<your storage account key>",
    "STORAGE_CONTAINER_NAME": "photos",
    "COSMOS_ENDPOINT": "https://<your-cosmos>.documents.azure.com:443/",
    "COSMOS_KEY": "<your cosmos primary key>",
    "COSMOS_DATABASE": "cloudphoto",
    "JWT_SECRET": "<random 48-char hex string>"
  }
}
```

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**3. Run** — open two terminals:

```bash
# Terminal 1 — Backend
cd server
yarn
yarn start        # TypeScript compile + func start on localhost:7071

# Terminal 2 — Frontend
cd client
yarn
yarn dev          # Vite dev server on localhost:3000 (proxies /api → :7071)
```

Open [http://localhost:3000](http://localhost:3000).

---

## Azure Setup

### Cosmos DB

1. Portal → **Azure Cosmos DB** → **+ Create** → **NoSQL API** → **Serverless** (free tier)
2. After deployment → **Data Explorer** → create database `cloudphoto` with three containers:

   | Container | Partition key |
   |-----------|---------------|
   | `users`   | `/id` |
   | `admins`  | `/id` |
   | `groups`  | `/id` |

3. Pre-seed `admins` with an entry for each admin email/username:
   ```json
   { "id": "2820396830@qq.com", "email": "2820396830@qq.com", "username": "zhangchi" }
   ```
4. **Keys** → copy **URI** and **PRIMARY KEY**.

> All containers are also created automatically on first run if they do not exist.

### Azure Blob Storage

1. Create a Storage Account (e.g. `photostorage`)
2. Create a container named `photos` with **Private** access
3. **Access keys** → copy **key1**

### Function App Application Settings

Portal → `cloudphoto-api` → **Settings → Environment variables → + Add**:

| Name | Value |
|------|-------|
| `COSMOS_ENDPOINT` | Cosmos DB URI |
| `COSMOS_KEY` | Cosmos DB primary key |
| `COSMOS_DATABASE` | `cloudphoto` |
| `JWT_SECRET` | Same random string as local |
| `STORAGE_ACCOUNT_NAME` | `photostorage` |
| `STORAGE_ACCOUNT_KEY` | Storage account key1 |
| `STORAGE_CONTAINER_NAME` | `photos` |

Click **Apply → Confirm** and wait for the Function App to restart.

---

## CI/CD (GitHub Actions)

Two workflows run automatically on push to `main`:

| Workflow | File | Trigger |
|----------|------|---------|
| Deploy Backend | `.github/workflows/deploy-backend.yml` | `server/**` changed |
| Deploy Frontend | `.github/workflows/deploy-frontend.yml` | `client/**` changed |

### Required GitHub Secrets

Settings → **Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | Service principal Application (client) ID |
| `AZURE_TENANT_ID` | Azure Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Azure Subscription ID |
| `AZURE_FUNCTIONAPP_NAME` | `cloudphoto-api` |
| `AZURE_RESOURCE_GROUP` | `CloudPhoto` |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | SWA deployment token (Portal → SWA → Manage deployment token) |
| `VITE_API_BASE` | `https://cloudphoto-api.azurewebsites.net/api` |

### OIDC Service Principal Setup

The backend workflow uses OpenID Connect (no stored passwords):

```bash
# Create service principal with Contributor role
az ad sp create-for-rbac \
  --name "cloudphoto-github" \
  --role contributor \
  --scopes /subscriptions/<SUB_ID>/resourceGroups/CloudPhoto \
  --sdk-auth

# Add federated credential for GitHub Actions
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
│   ├── deploy-backend.yml       # Build TypeScript, zip deploy via az CLI
│   └── deploy-frontend.yml      # Build Vite, deploy to Azure Static Web Apps
│
├── client/                      # React 18 + Vite 5
│   ├── public/
│   │   └── staticwebapp.config.json  # SPA fallback routing for SWA
│   ├── src/
│   │   ├── App.tsx              # Root component — global state, routing
│   │   ├── vite-env.d.ts        # Vite env type declarations
│   │   ├── index.css
│   │   ├── contexts/
│   │   │   ├── AuthContext.tsx  # Auth state: login / register / logout
│   │   │   └── GroupContext.tsx # Current group selection
│   │   ├── components/
│   │   │   ├── auth/
│   │   │   │   ├── AuthPage.tsx          # Login / Register tab UI
│   │   │   │   └── AddAdminDialog.tsx    # Promote user to admin
│   │   │   ├── gallery/
    │   │   │   ├── PhotoGallery.tsx      # Date-grouped timeline with download/rename
    │   │   │   ├── FolderView.tsx        # Sub-folder navigation, breadcrumb, drag-drop
│   │   │   │   ├── PhotoCard.tsx         # Thumbnail + delete confirmation
│   │   │   │   └── FilterBar.tsx         # Filter by name/subject/uploader/date
│   │   │   └── groups/
│   │   │       ├── GroupSwitcher.tsx     # Header dropdown: personal / groups
│   │   │       ├── CreateGroupDialog.tsx # Create group form
│   │   │       └── GroupSettings.tsx     # Members list + danger zone
│   │   └── services/
│   │       ├── photoApi.ts      # Auth + photo API calls (with timeout)
│   │       └── groupApi.ts      # Group API calls
│   ├── vite.config.ts           # /api proxy → localhost:7071 (dev only)
│   └── package.json
│
└── server/                      # Azure Functions v4 (Node.js 24 + TypeScript)
    ├── src/
    │   ├── index.ts             # Imports all function modules
    │   ├── functions/
    │   │   ├── auth/
    │   │   │   ├── authRegister.ts      # POST /api/auth/register
    │   │   │   ├── authLogin.ts         # POST /api/auth/login
    │   │   │   ├── authMe.ts            # GET  /api/auth/me
    │   │   │   └── authAddAdmin.ts      # POST /api/auth/admins
    │   │   ├── photos/
    │   │   │   ├── listPhotos.ts        # GET    /api/photos
    │   │   │   ├── uploadPhoto.ts       # POST   /api/photos/upload
    │   │   │   ├── downloadPhoto.ts     # GET    /api/photos/download
    │   │   │   ├── movePhoto.ts         # POST   /api/photos/move
    │   │   │   ├── updatePhotoMetadata.ts  # PATCH /api/photos/metadata
    │   │   │   └── deletePhoto.ts       # DELETE /api/photos
    │   │   └── groups/
    │   │       ├── createGroup.ts       # POST   /api/groups
    │   │       ├── listGroups.ts        # GET    /api/groups
    │   │       ├── getGroup.ts          # GET    /api/groups/{groupId}
    │   │       ├── updateGroup.ts       # PATCH  /api/groups/{groupId}
    │   │       ├── deleteGroup.ts       # DELETE /api/groups/{groupId}
    │   │       ├── addMember.ts         # POST   /api/groups/{groupId}/members
    │   │       └── removeMember.ts      # DELETE /api/groups/{groupId}/members/{memberId}
    │   └── utils/
    │       ├── blobStorage.ts   # BlobServiceClient + SAS URL generator (2h expiry)
    │       ├── cosmosClient.ts  # Cosmos DB client, UserDoc & GroupDoc types
    │       └── jwtUtils.ts      # JWT sign / verify / extract
    ├── host.json                # CORS config, route prefix "api"
    ├── local.settings.json      # Local secrets — git-ignored, never commit
    ├── .funcignore
    └── package.json
```

---

## Authentication Flow

### Registration
1. Client sends `{ username, email, displayName, password }`
2. Server checks username + email uniqueness in Cosmos DB
3. `bcrypt.hash(password, 10)` — password is never stored in plain text
4. Role determined by `admins` container (pre-seeded emails/usernames get `admin`; all others become `viewer`)
5. `UserDoc` written to `users` container
6. JWT signed (`expiresIn: "7d"`), returned with `{ token, user }`

### Login
1. Client sends `{ username, password }`
2. Server looks up user by username
3. `bcrypt.compare(password, passwordHash)` verifies without decrypting
4. Updates `lastLoginAt`, signs new JWT, returns `{ token, user }`

### Session Restore (on page reload)
1. App reads token from `localStorage`
2. Calls `GET /api/auth/me` — if token is missing or expired, redirect to login

All API requests attach `Authorization: Bearer <token>` via the `authHeaders()` helper in `photoApi.ts`. Auth calls have a **15-second timeout**; upload calls have a **60-second timeout**.
