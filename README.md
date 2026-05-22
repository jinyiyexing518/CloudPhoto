# CloudPhoto

A personal cloud photo storage app built with React + Vite (frontend) and Azure Functions (backend), backed by Azure Blob Storage.

## Architecture

```text
client/   →  React + Vite           (dev: http://localhost:3000)
server/   →  Azure Functions v4     (dev: http://localhost:7071)
storage   →  Azure Blob Storage     (account: photostorage, container: photos)
```

The Vite dev server proxies all `/api/*` requests to `localhost:7071`, so the frontend never needs to know the backend URL directly.

### API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/photos` | List all photos with 2-hour SAS URLs |
| `POST` | `/api/photos/upload?filename=<name>` | Upload a photo (raw binary body) |
| `DELETE` | `/api/photos/{name}` | Delete a photo by blob name |

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

> If port 7071 is already in use when starting the backend, stop the existing process with `Ctrl+C` before running `yarn start` again.

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

When deploying to Azure, add these as **Application Settings** in the Function App instead.

## Project Structure

```text
CloudPhoto/
├── client/                        # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx                # Root component, state management
│   │   ├── index.css              # Global styles
│   │   ├── components/
│   │   │   ├── PhotoGallery.tsx   # Photo grid + fullscreen modal
│   │   │   ├── PhotoCard.tsx      # Thumbnail card with delete button
│   │   │   └── UploadArea.tsx     # Drag-and-drop / click-to-upload
│   │   └── services/
│   │       └── photoApi.ts        # Typed fetch wrappers (list/upload/delete)
│   ├── vite.config.ts             # Proxies /api → localhost:7071
│   └── package.json
└── server/                        # Azure Functions v4 (Node.js)
    ├── src/
    │   ├── index.ts               # Registers all functions
    │   ├── functions/
    │   │   ├── listPhotos.ts      # GET  /api/photos
    │   │   ├── uploadPhoto.ts     # POST /api/photos/upload
    │   │   └── deletePhoto.ts     # DELETE /api/photos/{name}
    │   └── utils/
    │       └── blobStorage.ts     # BlobServiceClient + SAS URL generator
    ├── host.json
    ├── local.settings.json        # Local dev secrets (git-ignored)
    └── package.json
```
