# CloudPhoto

A personal cloud photo storage app built with React + Vite (frontend) and Azure Functions (backend), backed by Azure Blob Storage.

## Architecture

```
client/   →  React + Vite (port 3000)
server/   →  Azure Functions v4 Node.js (port 7071)
storage   →  Azure Blob Storage (photostorage account, "photos" container)
```

### API Endpoints

| Method   | Route                    | Description                        |
|----------|--------------------------|------------------------------------|
| GET      | `/api/photos`            | List all photos (with SAS URLs)    |
| POST     | `/api/photos/upload`     | Upload a photo (binary body)       |
| DELETE   | `/api/photos/{name}`     | Delete a photo by blob name        |

## Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)

```bash
npm install -g azure-functions-core-tools@4 --unsafe-perm true
```

## Getting Started

### 1. Start the backend

```bash
cd server
npm install
npm run dev      # compiles TypeScript then starts func on localhost:7071
```

### 2. Start the frontend

```bash
cd client
npm install
npm run dev      # Vite dev server on localhost:3000, proxies /api → 7071
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Server settings are in `server/local.settings.json` (excluded from git):

| Key                      | Description                        |
|--------------------------|------------------------------------|
| `STORAGE_ACCOUNT_NAME`   | Azure Storage account name         |
| `STORAGE_ACCOUNT_KEY`    | Azure Storage account access key   |
| `STORAGE_CONTAINER_NAME` | Blob container name (default: `photos`) |

## Project Structure

```
CloudPhoto/
├── client/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── PhotoGallery.tsx   # Grid view + fullscreen modal
│   │   │   ├── PhotoCard.tsx      # Thumbnail card with delete
│   │   │   └── UploadArea.tsx     # Drag-and-drop / click upload
│   │   └── services/
│   │       └── photoApi.ts        # fetch wrappers for the API
│   └── vite.config.ts
└── server/
    ├── src/
    │   ├── functions/
    │   │   ├── listPhotos.ts
    │   │   ├── uploadPhoto.ts
    │   │   └── deletePhoto.ts
    │   └── utils/
    │       └── blobStorage.ts     # BlobServiceClient + SAS URL helper
    ├── host.json
    └── local.settings.json        # local dev secrets (not committed)
```
