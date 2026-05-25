# CloudPhoto

A personal cloud photo storage app with user authentication, group sharing, and folder-based organisation, built with React + Vite (frontend) and Azure Functions v4 (backend), backed by Azure Blob Storage and Azure Cosmos DB.

## Architecture

```text
client/   →  React + Vite           (dev: http://localhost:3000)
server/   →  Azure Functions v4     (dev: http://localhost:7071)
storage   →  Azure Blob Storage     (account: photostorage, container: photos)
database  →  Azure Cosmos DB NoSQL  (database: cloudphoto)
               ├── users       (partition: /id)
               ├── admins      (partition: /id)
               └── groups      (partition: /id)  ← members + folders embedded
```

The Vite dev server proxies all `/api/*` requests to `localhost:7071`, so the frontend never needs to know the backend URL directly.

## Role System

| Role | Description |
|------|-------------|
| `admin` | Can access all content (private and group photos). Only `zhangchi` / `2820396830@qq.com` can be assigned this role. |
| `viewer` | Can only see their own private photos and photos in groups they belong to. |

Within a group, members also have a **group role**:

| Group Role | Permissions |
|------------|-------------|
| `admin` (group) | Can add / remove members, delete the group |
| `member` | Can view and upload photos to the group |

## Data Model

### UserDoc (`users` container)
```jsonc
{
  "id": "<uuid>",
  "username": "alice",
  "email": "alice@example.com",
  "displayName": "Alice",
  "passwordHash": "<bcrypt>",
  "role": "admin" | "viewer",
  "privateFolders": ["Holidays", "Work"],   // folder names in personal space
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
  "members": [                              // embedded — no separate container
    { "userId": "...", "username": "alice", "email": "...", "displayName": "Alice",
      "role": "admin", "joinedAt": "...", "addedBy": "..." }
  ],
  "folders": ["Arrival", "Beach", "Farewell"]  // folder names in this group
}
```

### Blob Metadata (Azure Blob Storage)
Each photo blob carries metadata:
```
originalName   base64-encoded original filename
subject        optional subject/caption
folder         folder name (empty = uncategorised)
groupId        group this photo belongs to (empty = private)
createdBy      uploader display name
createdById    uploader userId
createdAt      ISO timestamp
lastModifiedBy display name of last editor
lastModifiedAt ISO timestamp
```

## API Endpoints

### Auth

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/auth/register` | — | Register a new user |
| `POST` | `/api/auth/login` | — | Login, returns JWT token |
| `GET`  | `/api/auth/me` | Required | Get current user info |
| `POST` | `/api/auth/add-admin` | Admin only | Promote a user to admin |

### Photos

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET`    | `/api/photos` | Required | List photos (filtered by group / ownership) |
| `POST`   | `/api/photos/upload?filename=<name>` | Required | Upload a photo (raw binary body) |
| `PATCH`  | `/api/photos/{name}/metadata` | Required | Update subject / folder / updatedBy |
| `DELETE` | `/api/photos/{name}` | Required | Delete a photo by blob name |

**Ownership rules for `GET /api/photos`:**
- `?groupId=<id>` — returns photos for that group (requester must be a member)
- No `groupId` — returns the requester's private photos only (admin sees all private photos)

### Groups

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST`   | `/api/groups` | Required | Create a group (creator becomes group admin) |
| `GET`    | `/api/groups` | Required | List groups the user belongs to |
| `GET`    | `/api/groups/{groupId}` | Member / Admin | Get group details + member list |
| `PATCH`  | `/api/groups/{groupId}` | Group admin | Update group name / description |
| `DELETE` | `/api/groups/{groupId}` | Group admin | Delete the group |
| `POST`   | `/api/groups/{groupId}/members` | Group admin | Add a member by username |
| `DELETE` | `/api/groups/{groupId}/members/{memberId}` | Group admin / self | Remove a member |

All protected endpoints require the header: `Authorization: Bearer <token>`

## Authentication Flow

### Registration (`POST /api/auth/register`)

1. Client sends `{ username, email, displayName, password }`
2. Server checks uniqueness of username + email in Cosmos DB
3. `bcrypt.hash(password, 10)` — password is never stored in plain text
4. `role` is determined by the admins container (only pre-approved emails get `admin`)
5. `UserDoc` written with `privateFolders: []`
6. JWT signed (`expiresIn: "7d"`) and returned with `{ token, user }`

### Login (`POST /api/auth/login`)

1. Client sends `{ username, password }`
2. Server looks up user by username
3. `bcrypt.compare(password, passwordHash)` verifies without decrypting
4. Updates `lastLoginAt`, signs a new JWT, returns `{ token, user }`

### Session Restore

On every page load the app reads the token from `localStorage`, calls `GET /api/auth/me`, and redirects to the login page if the token is missing or expired.

## Features

- **User authentication** — register / login / logout with JWT (7-day expiry)
- **Role system** — global `admin` / `viewer`; per-group `admin` / `member`
- **Private photo space** — personal folders visible only to the owner (admin sees all)
- **Group sharing** — create groups, add members by username, share photos within groups
- **Folder view** — photos organised into named folders; upload directly into a folder with an optional subject tag
- **Timeline view** — date-grouped photo gallery, newest first
- **Search & filter** — filter by name, subject, uploader, date range
- **Fullscreen modal** — view details, edit subject inline
- **Delete with confirmation** — custom confirm dialog (no browser alert)
- **Admin tools** — promote other users to admin (super-admin only)

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Azure Blob Storage account
- Azure Cosmos DB (NoSQL API) account

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

## Getting Started

Open **two terminals**:

**Terminal 1 — Backend**

```bash
cd server
yarn          # install dependencies (first time only)
yarn start    # compiles TypeScript, then starts func on localhost:7071
```

**Terminal 2 — Frontend**

```bash
cd client
yarn          # install dependencies (first time only)
yarn dev      # starts Vite on localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Server settings live in `server/local.settings.json` (git-ignored — never commit this file):

| Key | Description |
|-----|-------------|
| `STORAGE_ACCOUNT_NAME` | Azure Storage account name |
| `STORAGE_ACCOUNT_KEY` | Azure Storage account access key |
| `STORAGE_CONTAINER_NAME` | Blob container name (default: `photos`) |
| `COSMOS_ENDPOINT` | Cosmos DB account URI (e.g. `https://xxx.documents.azure.com:443/`) |
| `COSMOS_KEY` | Cosmos DB primary key |
| `COSMOS_DATABASE` | Database name (default: `cloudphoto`) |
| `JWT_SECRET` | Random secret for signing JWTs — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

### Setting up Cosmos DB

1. Azure Portal → **Azure Cosmos DB** → **+ Create** → choose **NoSQL API**
2. Choose **Serverless** capacity mode (free tier for development)
3. After deployment: **Data Explorer** → **New Database** `cloudphoto`
4. Create three containers:

   | Container | Partition key |
   |-----------|--------------|
   | `users`   | `/id` |
   | `admins`  | `/id` |
   | `groups`  | `/id` |

5. Pre-seed the `admins` container with a doc `{ "id": "<email>", "email": "<email>", "role": "admin" }` for each admin user.
6. Go to **Keys** → copy **URI** and **PRIMARY KEY** into `local.settings.json`.

> All containers are also created automatically on first run if they do not exist.

When deploying to Azure, add all keys as **Application Settings** in the Function App.

## Project Structure

```text
CloudPhoto/
├── client/                          # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx                  # Root component, global state & routing
│   │   ├── index.css                # Global styles
│   │   ├── contexts/
│   │   │   ├── AuthContext.tsx      # Auth state, login / register / logout
│   │   │   └── GroupContext.tsx     # Current group selection & group list
│   │   ├── components/
│   │   │   ├── auth/
│   │   │   │   ├── AuthPage.tsx     # Login / Register page (tab UI)
│   │   │   │   └── AddAdminDialog.tsx
│   │   │   ├── gallery/
│   │   │   │   ├── PhotoGallery.tsx # Date-grouped timeline view
│   │   │   │   ├── FolderView.tsx   # Folder-based view with per-folder upload
│   │   │   │   ├── PhotoCard.tsx    # Thumbnail card with delete confirmation
│   │   │   │   ├── FilterBar.tsx    # Search + filter controls
│   │   │   │   └── SearchBar.tsx
│   │   │   └── groups/
│   │   │       ├── GroupSwitcher.tsx      # Header dropdown: personal / groups
│   │   │       ├── CreateGroupDialog.tsx  # Create new group form
│   │   │       └── GroupSettings.tsx      # Group info, members, danger zone
│   │   └── services/
│   │       ├── photoApi.ts          # Photo CRUD — auth + photo endpoints
│   │       └── groupApi.ts          # Group CRUD — group endpoints
│   ├── vite.config.ts               # Proxies /api → localhost:7071
│   └── package.json
└── server/                          # Azure Functions v4 (Node.js + TypeScript)
    ├── src/
    │   ├── index.ts                 # Registers all functions
    │   ├── functions/
    │   │   ├── auth/
    │   │   │   ├── authRegister.ts  # POST /api/auth/register
    │   │   │   ├── authLogin.ts     # POST /api/auth/login
    │   │   │   ├── authMe.ts        # GET  /api/auth/me
    │   │   │   └── authAddAdmin.ts  # POST /api/auth/add-admin
    │   │   ├── photos/
    │   │   │   ├── listPhotos.ts        # GET    /api/photos
    │   │   │   ├── uploadPhoto.ts       # POST   /api/photos/upload
    │   │   │   ├── updatePhotoMetadata.ts  # PATCH /api/photos/{name}/metadata
    │   │   │   └── deletePhoto.ts       # DELETE /api/photos/{name}
    │   │   └── groups/
    │   │       ├── createGroup.ts   # POST   /api/groups
    │   │       ├── listGroups.ts    # GET    /api/groups
    │   │       ├── getGroup.ts      # GET    /api/groups/{groupId}
    │   │       ├── updateGroup.ts   # PATCH  /api/groups/{groupId}
    │   │       ├── deleteGroup.ts   # DELETE /api/groups/{groupId}
    │   │       ├── addMember.ts     # POST   /api/groups/{groupId}/members
    │   │       └── removeMember.ts  # DELETE /api/groups/{groupId}/members/{memberId}
    │   └── utils/
    │       ├── blobStorage.ts       # BlobServiceClient + SAS URL generator
    │       ├── cosmosClient.ts      # Cosmos DB client, UserDoc, GroupDoc interfaces
    │       └── jwtUtils.ts          # JWT sign / verify / extract from header
    ├── host.json
    ├── local.settings.json          # Local dev secrets (git-ignored)
    └── package.json
```


## Architecture

```text
client/   →  React + Vite           (dev: http://localhost:3000)
server/   →  Azure Functions v4     (dev: http://localhost:7071)
storage   →  Azure Blob Storage     (account: photostorage, container: photos)
database  →  Azure Cosmos DB NoSQL  (database: cloudphoto, container: users)
```

The Vite dev server proxies all `/api/*` requests to `localhost:7071`, so the frontend never needs to know the backend URL directly.

### API Endpoints

#### Photos

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/photos` | Required | List all photos with 2-hour SAS URLs |
| `POST` | `/api/photos/upload?filename=<name>` | Required | Upload a photo (raw binary body) |
| `PATCH` | `/api/photos/{name}/metadata` | Required | Update subject / updatedBy |
| `DELETE` | `/api/photos/{name}` | Required | Delete a photo by blob name |

#### Auth

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/auth/register` | — | Register a new user |
| `POST` | `/api/auth/login` | — | Login, returns JWT token |
| `GET` | `/api/auth/me` | Required | Get current user info |

All protected endpoints require the header: `Authorization: Bearer <token>`

## Authentication Flow

### Registration (`POST /api/auth/register`)

```
Client                        Azure Function              Cosmos DB
  │                                │                          │
  │  { username, email,            │                          │
  │    displayName, password }     │                          │
  │──────────────────────────────>│                          │
  │                                │  Query: username/email   │
  │                                │  already exists?        │
  │                                │─────────────────────────>│
  │                                │<─────────────────────────│
  │                                │                          │
  │                                │  bcrypt.hash(password)  │
  │                                │  → passwordHash          │
  │                                │                          │
  │                                │  First user ever?        │
  │                                │  → role = "admin"        │
  │                                │  Others → role = "viewer"│
  │                                │                          │
  │                                │  Write UserDoc:          │
  │                                │  { id (UUID), username,  │
  │                                │    email, displayName,   │
  │                                │    passwordHash, role,   │
  │                                │    createdAt, lastLoginAt}│
  │                                │─────────────────────────>│
  │                                │                          │
  │                                │  jwt.sign(               │
  │                                │    { userId, username,   │
  │                                │      displayName, role },│
  │                                │    JWT_SECRET,           │
  │                                │    { expiresIn: "7d" })  │
  │                                │                          │
  │  { token, user }               │                          │
  │<──────────────────────────────│                          │
  │                                │                          │
  │  localStorage["cloudphoto_    │                          │
  │    token"] = token             │                          │
  │  → enter app as logged-in user │                          │
```

**Key points:**
- Passwords are never stored. Only the bcrypt hash (salted, cost factor 10) is saved.
- The **first** registered account automatically becomes `admin`; all subsequent accounts are `viewer`.
- Token expires in 7 days. On expiry the user is redirected to the login page.

### Login (`POST /api/auth/login`)

1. Client sends `{ username, password }`
2. Server looks up user by username in Cosmos DB
3. `bcrypt.compare(password, passwordHash)` — verifies without decrypting
4. If valid: updates `lastLoginAt`, signs a new JWT, returns `{ token, user }`
5. Client stores token in `localStorage` and enters the app

### Session Restore (on page reload)

1. App reads token from `localStorage`
2. Calls `GET /api/auth/me` with `Authorization: Bearer <token>`
3. Server verifies JWT signature and expiry, returns user info
4. If token is missing or invalid, user is redirected to the login page

### Token Usage

Every API request (photos list, upload, delete, metadata) automatically includes:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```
This is added centrally in `photoApi.ts` via the `authHeaders()` helper.

## Features

- **User authentication** — register / login / logout with JWT
- **Role system** — `admin` (first user) / `viewer`
- **Upload photos** — drag-and-drop or click to select, supports Chinese filenames
- **Metadata** — subject, uploaded by, created/modified timestamps
- **Search & filter** — filter by name, subject, uploader, date range
- **Date-grouped gallery** — photos grouped by creation date, newest first
- **Fullscreen modal** — view details, edit subject inline
- **Delete with confirmation** — custom confirm dialog (no browser alert)

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- Azure Blob Storage account
- Azure Cosmos DB (NoSQL API) account

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

## Getting Started

Open **two terminals**:

**Terminal 1 — Backend**

```bash
cd server
yarn          # install dependencies (first time only)
yarn start    # compiles TypeScript, then starts func on localhost:7071
```

**Terminal 2 — Frontend**

```bash
cd client
yarn          # install dependencies (first time only)
yarn dev      # starts Vite on localhost:3000
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Server settings live in `server/local.settings.json` (git-ignored — never commit this file):

| Key | Description |
|-----|-------------|
| `STORAGE_ACCOUNT_NAME` | Azure Storage account name |
| `STORAGE_ACCOUNT_KEY` | Azure Storage account access key |
| `STORAGE_CONTAINER_NAME` | Blob container name (default: `photos`) |
| `COSMOS_ENDPOINT` | Cosmos DB account URI (e.g. `https://xxx.documents.azure.com:443/`) |
| `COSMOS_KEY` | Cosmos DB primary key |
| `COSMOS_DATABASE` | Database name (default: `cloudphoto`) |
| `JWT_SECRET` | Random secret for signing JWTs — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

### Setting up Cosmos DB

1. Azure Portal → **Azure Cosmos DB** → **+ Create** → choose **NoSQL API**
2. Choose **Serverless** capacity mode (free tier for development)
3. After deployment: **Data Explorer** → **New Container**
   - Database id: `cloudphoto`
   - Container id: `users`
   - Partition key: `/id`
4. Go to **Keys** → copy **URI** and **PRIMARY KEY** into `local.settings.json`

> The `users` container is also created automatically on first run if it does not exist.

When deploying to Azure, add all keys as **Application Settings** in the Function App.

## Project Structure

```text
CloudPhoto/
├── client/                        # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx                # Root component, state management
│   │   ├── index.css              # Global styles
│   │   ├── contexts/
│   │   │   └── AuthContext.tsx    # Auth state, login/register/logout actions
│   │   ├── components/
│   │   │   ├── AuthPage.tsx       # Login / Register page (tab UI)
│   │   │   ├── PhotoGallery.tsx   # Date-grouped photo grid + fullscreen modal
│   │   │   ├── PhotoCard.tsx      # Thumbnail card with delete confirmation
│   │   │   ├── FilterBar.tsx      # Search + filter by subject/uploader/date
│   │   │   └── UploadArea.tsx     # Drag-and-drop / click-to-upload
│   │   └── services/
│   │       └── photoApi.ts        # Typed fetch wrappers — auth + photo APIs
│   ├── vite.config.ts             # Proxies /api → localhost:7071
│   └── package.json
└── server/                        # Azure Functions v4 (Node.js + TypeScript)
    ├── src/
    │   ├── index.ts               # Registers all functions
    │   ├── functions/
    │   │   ├── authRegister.ts    # POST /api/auth/register
    │   │   ├── authLogin.ts       # POST /api/auth/login
    │   │   ├── authMe.ts          # GET  /api/auth/me
    │   │   ├── listPhotos.ts      # GET  /api/photos
    │   │   ├── uploadPhoto.ts     # POST /api/photos/upload
    │   │   ├── updatePhotoMetadata.ts  # PATCH /api/photos/{name}/metadata
    │   │   └── deletePhoto.ts     # DELETE /api/photos/{name}
    │   └── utils/
    │       ├── blobStorage.ts     # BlobServiceClient + SAS URL generator
    │       ├── cosmosClient.ts    # Cosmos DB client + UserDoc interface
    │       └── jwtUtils.ts        # JWT sign / verify / extract from header
    ├── host.json
    ├── local.settings.json        # Local dev secrets (git-ignored)
    └── package.json
```

