# CloudPhoto

A full-stack personal cloud photo storage app with user authentication, JWT refresh tokens, group sharing, folder organisation, and zero-key security via Azure Managed Identity.

For end users, see: [USER_GUIDE.md](USER_GUIDE.md)

**Frontend:** React 18 + Vite 5 → deployed to **Azure Static Web Apps**  
**Backend:** Azure Functions v4 (Node.js 24, TypeScript) → deployed to **Azure Functions** (`cloudphoto-api`)  
**Storage:** Azure Blob Storage (`photostorage` / `photos`) — accessed via **User Delegation SAS** (no account key)  
**Database:** Azure Cosmos DB NoSQL (`cloudphoto`) — accessed via **Managed Identity** (no connection string key)

---

## Changelog

### v1.5.0 — Product upgrade (40 improvements)

**Features (10)**
- F1 Storage usage display: weekly summary card now shows total space occupied (`💾 占用存储`)
- F2 Tab switch scrolls to top: switching tabs now auto-scrolls to page top
- F3 Keyboard shortcuts 1/2/3: press 1=时间线, 2=文件夹, 3=重要片段 from anywhere
- F4 Keyboard shortcut S: press S to open/close the sidebar
- F5 Sort toggle: "↓ 最新" / "↑ 最早" pill chip in timeline to reverse date group order
- F6 Install banner auto-dismisses after 10 seconds if not acted on
- F7 Group name badge: current group name shown as a pill badge inside the header h1
- F8 Shortcuts dialog updated with the new 1/2/3 and S shortcuts
- F9 Filters auto-reset on group switch — no more stale filters when switching spaces
- F10 Upload progress percentage: transfer banner now shows e.g. "67%" alongside the progress bar

**Bug fixes / optimizations (10)**
- B1 FilterBar: all UI strings localized to Chinese (搜索名称, 清空全部, 主题, 上传者, 开始日期, 截止日期)
- B2 PhotoCard delete dialog: localized to Chinese (删除照片?, 取消, 删除)
- B3 UploadArea: localized to Chinese (拖拽或点击上传照片, 上传中...)
- B4 Backspace/Delete to clear filters now also scrolls to top
- B5 Sidebar no longer auto-opens on every tab mount — only when explicitly activated
- B6 Switching to folder tab now closes the sidebar
- B7 Toast notifications: `ua`/`isIOS`/`isAndroid` moved to module level (computed once, not per render)
- B8 `fetchPhotos` uses AbortController — stale in-flight requests are cancelled on re-fetch
- B9 Storage estimate uses actual `photo.size` bytes, not a rough guess
- B10 Weekly summary clipboard report now includes storage size

**UI upgrades (10)**
- U1 Upload % label beside progress bar (e.g. "67%")
- U2 Photo thumbnail hover shows a gradient date overlay at the bottom of the image (CSS-only)
- U3 Toast redesign: click-to-dismiss ✕ button on every notification
- U4 Scroll-to-top button: gradient blue→purple pill with glow shadow
- U5 Reading progress bar: 4px height + purple glow effect
- U6 Header shows current group name as a styled badge pill
- U7 Sort order chip: purple-toned pill consistent with the chip row
- U8 FAB filter count badge: orange→red gradient badge showing active filter count
- U9 Empty gallery icon: wrapped in gradient rounded square container
- U10 App loading splash: bouncing dots animation added

**Performance (10)**
- P1 `PhotoCard` wrapped with `React.memo` — prevents unnecessary re-renders in large galleries
- P2 `img` elements get `decoding="async"` — non-blocking image decoding on the main thread
- P3 CSS `contain: layout style` on `.photo-grid` — scopes repaint to the grid
- P4 `index.html` adds `<link rel="preconnect">` and `dns-prefetch` for the API endpoint
- P5 CSS `content-visibility: auto` on `.date-group` sections — skips off-screen rendering
- P6 `fetchPhotos` uses `AbortController` to cancel stale requests
- P7 `ua`/`isIOS`/`isAndroid` moved outside component — avoids recalculation on every render
- P8 `view-tab-count` transition reduced to color-only (removes box-shadow recalculation)
- P9 PWA Workbox: `StaleWhileRevalidate` cache strategy added for Azure Blob image URLs
- P10 Version bumped to `1.5.0`



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
- **Folder share dialog** — sharing the current folder now opens a dedicated dialog with explicit duration options instead of occupying toolbar space with an inline expiry picker
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
- **Photo-first focus toolbar** — the home surface now uses a compact top toolbar to show current space, lightweight counts, runtime mode, and a few high-value navigation actions without pushing photo content too far down the page
- **Full-height partial-width workspace sidebar** — timeline and moments now use a full-height right-side panel that occupies roughly 80%–90% of the horizontal space, leaving a visible darkened margin so it reads clearly as a side panel instead of a full takeover
- **Grouped floating pill controls** — the sidebar entry is now a capsule-style floating control group with a primary pill and secondary chips, giving users clearer, more discoverable entry points into filtering, cleanup, sharing, and diagnostics
- **Recent activity feed** — the sidebar can surface the latest uploads, share creations, and sync updates without forcing those summaries above the photo content
- **Cleanup assistant** — the sidebar highlights photos without subjects and uncategorised photos, with one-click jumps into focused timeline cleanup views and automatic scroll-to-target positioning
- **Share watchlist** — the sidebar flags active share links expiring within 48 hours and provides a direct path into share maintenance
- **Count-aware tab navigation** — Timeline / Folder / Moments tabs now display live counts so users can judge where to go without trial-and-error switching
- **Stable top tab rail** — the three primary tabs now avoid awkward wrapping by using a compact, horizontally stable rail that stays readable on narrower widths
- **Visible drag affordance** — the top tab rail now includes clearer swipe/drag cues so users understand it can scroll horizontally instead of mistaking clipped tabs for a rendering bug
- **Quick date filter chips** — "今日 / 本周 / 本月 / ⭐ 收藏" one-tap chip row in the timeline tab bar for instant date-scoped browsing without opening the sidebar; active chip is highlighted and "✕ 清空" appears when any filter is on
- **Active filter indicator dot** — a small amber dot appears on the Timeline tab label whenever any filter is active so users never lose track of a hidden search
- **Empty-album first-run state** — when a space has no photos yet, the gallery shows a friendly "还没有照片" prompt with a direct CTA to the upload view instead of a blank grid
- **Transfer progress banner** — while uploading, a sticky banner displays the current filename, a live `n/total` counter, a progress bar, and a percentage figure (e.g. "67%"); during download it shows a "下载中，请勿关闭页面" notice
- **Scroll-to-top button** — a floating circular button appears after scrolling 500 px and smoothly returns the viewport to the top with one tap; hidden during sidebar scroll-lock
- **Window-focus auto-refresh** — switching back to the app from another tab or app silently re-fetches the photo list (throttled to at most once per 60 s) so multi-device edits appear without manual reload
- **Keyboard shortcuts** — press **R** to refresh; **1 / 2 / 3** to switch Timeline / Folder / Moments tabs; **S** to toggle the workspace sidebar; **Backspace / Delete** to clear all active filters with scroll-to-top; **?** to open the shortcuts cheatsheet; **Esc** to dismiss any overlay; all shortcuts skip input/textarea focus
- **Timeline sort toggle** — a "↓ 最新 / ↑ 最早" chip in the quick-filter row instantly reverses the date-group order so users can browse from the oldest photo upward without touching any filter
- **Group context header badge** — when browsing a group space, a "👥 GroupName" pill badge appears next to the app title for at-a-glance space confirmation
- **Toast dismiss button** — every toast notification includes a ✕ button for immediate manual dismissal before the 3.5 s auto-dismiss timer fires
- **FAB filter count badge** — the floating workspace pill shows an orange/red badge with the active filter count when any timeline filter is on, visible without opening the sidebar
- **Install banner auto-dismiss** — the PWA install suggestion banner automatically hides after 10 seconds if the user takes no action, reducing persistent visual noise
- **Group-switch filter reset** — switching between personal space and any group automatically clears all active timeline filters to prevent stale searches carrying over into unrelated contexts
- **Upload filename in progress** — upload progress now tracks the current file being sent so in-flight status shows exactly which photo is uploading rather than a generic count
- **Photo count header badge** — the header count now uses locale-formatted numerals (e.g. "1,234 张") and shows a green "+N 近7天" pill when photos were uploaded in the last 7 days
- **Timeline memory highlights** — automatically surfaces "历史回忆" photos from the same month/day in previous years
- **Important moments tab** — moments are ranked by engagement and shown in a dedicated ⭐ tab with independent filters and sort modes
- **Moments cross-device analytics** — open/navigate in moments records views to backend (Cosmos), including total views, last viewed time, top viewer, and peak day; counters are updated atomically in Cosmos and no longer rely on local page-only state
- **Moments count stabilization** — client-side moments counters now merge optimistic updates with server responses defensively so delayed responses do not easily cause visible count regressions or jitter
- **Moments local fallback** — if the backend moments store is temporarily unavailable, the client preserves view counts locally across refreshes and marks the session as local-only until server sync resumes
- **Moments diagnostics tab** — Settings now includes a dedicated diagnostics tab showing frontend version/build time, service worker count, local moments cache size, and whether moments persistence is local-only or server-synced
- **Card-based settings panel** — Settings now uses a stronger visual hierarchy with hero headers, grouped cards, and denser information blocks so profile, security, app, and diagnostics content are easier to scan
- **More restrained settings iconography** — settings hero icons now use softer, tab-specific tones instead of a single saturated blue treatment, improving clarity and reducing visual blur
- **Settings deep links** — home-level action cards can open Settings directly on the App or Diagnostics tabs and scroll to the relevant section or share entry, reducing navigation cost for share maintenance and troubleshooting
- **Moments details focus** — moments modal details focus on recommendation score + engagement metrics (not timeline-style upload/modify metadata)
- **Recoverable empty states** — timeline and moments now show actionable no-result states with one-click reset / go-to-folder recovery actions instead of passive blank screens
- **Timeline pagination** — timeline initially loads the newest page and can load more progressively to keep first paint fast
- **Search & filter** — filter by name, subject, uploader, date range, missing subject, and uncategorised photos
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
- **Mobile responsive UI** — 2-column grid, compact header, touch-friendly modals on screens ≤ 680 px; the folder tab now adapts to two columns on mobile for folders, photos, and upload tiles
- **Admin tools** — super-admin (configured via `SUPER_ADMIN_USERNAME` env var) can promote other users to admin
- **PWA app mode** — installable as an app on desktop/mobile (manifest + service worker + update prompt)
- **Browser-first update mode** — regular browser sessions prefer immediate updates by unregistering stale service workers; only installed standalone mode keeps persistent SW caching semantics
- **Reading progress bar** — a thin gradient bar at the very top of the viewport fills as the user scrolls through the photo timeline, providing instant spatial orientation
- **Global drag-drop hint** — dragging image files anywhere over the app window triggers a full-screen overlay guiding users to the folder view; dropping auto-redirects and shows a toast, eliminating the "how do I upload?" discoverability gap
- **Keyboard shortcuts help panel** — press `?` at any time (or click ⌨️ in the header) to open a floating cheatsheet of all keyboard shortcuts; press Escape or `?` again to dismiss
- **Backspace / Delete clears filters** — when any filter is active and focus is not in an input, pressing Backspace or Delete clears all timeline filters in one keystroke with a toast confirmation
- **Folder quick-filter chips** — the timeline chip row now shows up to 4 folder chips alongside the date chips, letting users instantly scope the timeline to a single folder without opening the sidebar
- **Today uploads notice** — when photos were uploaded today, a green notice bar appears above the timeline grid with a one-tap button to toggle "今日" filter; removed when no uploads for today
- **Time-of-day greeting** — the header title shows a contextual greeting ("早上好", "下午好", "晚上好") so the UI feels alive even before photos load
- **Upload file size summary** — the upload progress banner now shows total file count and MB (e.g. "5 张 · 12.3 MB") alongside the per-file name so users can judge remaining time at a glance
- **Weekly summary card** — a collapsible "📊 本周概况" card surfaces this-week uploads, total favorites, folder count, storage used (aggregated from blob size metadata), and today count; includes a "📋 复制周报" button that copies the summary (including storage size) to the clipboard
- **Dev refresh stability** — local Vite dev mode disables SW registration by default to avoid development-time refresh loops
- **Dev refresh stability** — PWA service worker registration is disabled in Vite dev mode to avoid local development refresh loops
- **Transfer safety guard** — while upload/download is in progress, tab switching is blocked and browser refresh/close shows unload confirmation
- **Keyless security** — no storage account keys or Cosmos DB keys anywhere; `DefaultAzureCredential` (Managed Identity on Azure, Azure CLI locally)
- **CI/CD** — GitHub Actions with OIDC authentication (no stored passwords); separate workflows for frontend and backend, triggered only on relevant path changes
- **Auto-hide header** — the top navigation bar slides up when scrolling down and reappears instantly on scroll-up or scroll-to-top; smooth 300 ms cubic-bezier animation maximises photo canvas on mobile without losing navigation
- **Nav corner masking** — a full-width page-background overlay wraps the sticky tab shell, masking the transparent rounded-corner areas so photo content never bleeds through the card edges during scroll
- **Pinch-to-zoom in modal** — photo detail modal supports two-finger pinch-to-zoom and double-tap to zoom for natural mobile inspection; smooth CSS transform with momentum release
- **Swipe between photos** — horizontal swipe gesture in the detail modal navigates to the next / previous photo; replaces keyboard-only navigation for touch devices
- **Batch tag editing** — select multiple photos in batch mode and apply or replace the subject tag for all at once; useful for tagging a shoot after bulk upload
- **Photo search bar** — a persistent search input that fuzzy-matches filename and subject simultaneously; debounced 300 ms; clear button appears when active; result count shown inline
- **Upload drag preview** — when files are dragged over the browser window a full-screen overlay shows a drop target with file count from the drag payload, giving immediate feedback before release
- **Per-folder quota indicator** — the folder view shows a small progress bar per folder representing photo count relative to a configurable soft cap, surfacing folders that are growing too large
- **Smart date grouping labels** — timeline date group headers use relative labels ("今天", "昨天", "本周", "上个月") for recent dates and ISO yyyy-mm-dd for older ones, reducing cognitive load for recent activity
- **Contextual empty-state actions** — empty folder view now shows two CTAs ("上传照片" and "新建子文件夹") so users have a clear next step instead of a blank grid

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
  "id": "moment:<base64url(photoName)>",
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
| `POST`   | `/api/photos/moments/insights` | ✓ | Batch query moments analytics for specified photos via JSON body `{ photoNames: string[] }` (cross-device persisted, avoids oversized URLs) |
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
- Yarn (repo standard; keep a single root `yarn.lock`)
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
yarn install
```

**2. Configure backend secrets** — create `packages/server/local.settings.json` (git-ignored):

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
yarn dev:server                   # func start on localhost:7071

# Terminal 2 — Frontend
yarn dev:client                   # Vite on localhost:3000 (proxies /api → :7071)
```

Open [http://localhost:3000](http://localhost:3000).

### Feature Folder Convention

- Client share feature utilities are grouped under `packages/client/src/features/share/`.
- Server share-related HTTP functions are grouped under `packages/server/src/functions/share/`.
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
| Deploy Backend | `.github/workflows/deploy-backend.yml` | `packages/server/**` changed |
| Deploy Frontend | `.github/workflows/deploy-frontend.yml` | `packages/client/**` changed |

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
│       ├── App.tsx              # Root component — data loading, top-level routing, dialogs, transfer guard
│       ├── index.css            # Global styles + responsive breakpoints + batch-select UI
│       ├── contexts/
│       │   ├── AuthContext.tsx  # JWT auth state: login / register / logout / token persistence
│       │   ├── GroupContext.tsx # Current group selection
│       │   └── ToastContext.tsx # Toast notification queue (success / error / info)
│       ├── components/
│       │   ├── auth/
│       │   │   ├── AuthPage.tsx          # Login / Register tab UI
│       │   │   └── AddAdminDialog.tsx    # Promote user to admin
│       │   ├── home/
│       │   │   ├── WorkspaceSidebar.tsx  # Context-aware right sidebar for timeline / moments filters and insights
│       │   │   └── floating/
│       │   │       └── WorkspaceFab.tsx  # Floating pill control group for opening sidebar tools
│       │   ├── gallery/
│       │   │   ├── PhotoGallery.tsx      # Date-grouped timeline + batch selection + focused photo targeting
│       │   │   ├── FolderView.tsx        # Sub-folder navigation, breadcrumb, drag-drop, batch ops, share links
│       │   │   ├── TrashView.tsx         # Recycle bin — restore or permanently delete
│       │   │   ├── PhotoCard.tsx         # Thumbnail + selection badge + delete confirmation
│       │   │   └── FilterBar.tsx         # Filter by name / subject / uploader / date / missing-subject / uncategorised
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
