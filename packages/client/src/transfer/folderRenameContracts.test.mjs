import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
const folder = readFileSync(new URL("../components/gallery/FolderView.tsx", import.meta.url), "utf8");
const photoApi = readFileSync(new URL("../services/photoApi.ts", import.meta.url), "utf8");
const headerCss = readFileSync(new URL("../authenticated.css", import.meta.url), "utf8");
const renameState = readFileSync(new URL("./folderRenameState.ts", import.meta.url), "utf8");

test("folder rename API remains call-compatible and adds AbortSignal plus Azure HTTP cap", () => {
  assert.match(photoApi, /renameFolderApi\([\s\S]*groupId\?: string,[\s\S]*signal\?: AbortSignal/);
  assert.match(photoApi, /body: JSON\.stringify\(\{ oldFolder, newFolder, groupId \}\),[\s\S]*signal/);
  assert.match(photoApi, /220_000/);
});

test("FolderView validates locally and keeps root and recursive controls truly disabled", () => {
  assert.match(folder, /validateFolderRenameInput/);
  assert.match(folder, /folderRenameActive\?: boolean/);
  assert.match(folder, /const mutationBusy = batchMutationBusy \|\| folderRenameActive/);
  assert.match(renameState, /同级文件夹/);
  assert.ok((folder.match(/<FolderCard/g) ?? []).length >= 3);
  assert.ok((folder.match(/interactionDisabled=\{mutationBusy\}/g) ?? []).length >= 2);
  assert.match(folder, /interactionDisabled=\{batchMutationBusy\}/);
  assert.match(folder, /className="folder-card-rename-btn"[\s\S]{0,260}disabled=\{interactionDisabled\}/);
  assert.match(folder, /className="folder-card-delete-btn"[\s\S]{0,260}disabled=\{interactionDisabled\}/);
  assert.match(folder, /folder-new-btn[\s\S]{0,180}disabled=\{mutationBusy\}/);
  assert.match(folder, /folder-create-confirm[\s\S]{0,180}disabled=\{mutationBusy\}/);
  assert.match(folder, /<FolderContent[\s\S]*batchMutationBusy=\{mutationBusy\}/);
  assert.match(folder, /<BatchOperationsBar[\s\S]*busy=\{batchMutationBusy\}/);
  assert.match(folder, /modal-move-select[\s\S]{0,220}disabled=\{batchMutationBusy\}/);
  assert.match(folder, /上传原图到当前文件夹[\s\S]{0,280}disabled=\{anyUploading \|\| batchMutationBusy\}/);
  assert.match(folder, /onDelete=\{onDeleteSubFolder[\s\S]{0,180}interactionDisabled=\{batchMutationBusy\}/);
});

test("folder cards keep the group, open target, and actions as separate keyboard stops", () => {
  const card = folder.slice(
    folder.indexOf("function FolderCard("),
    folder.indexOf("// ─── Props", folder.indexOf("function FolderCard(")),
  );
  const openStart = card.indexOf('className="folder-card-open"');
  const openEnd = card.indexOf("</button>", openStart);
  const renameStart = card.indexOf('className="folder-card-rename-btn"');
  const deleteStart = card.indexOf('className="folder-card-delete-btn"');
  const outerTag = card.slice(card.indexOf("<div"), card.indexOf("onDragOver"));
  const openButton = card.slice(card.lastIndexOf("<button", openStart), openEnd + "</button>".length);

  assert.match(outerTag, /role="group"/);
  assert.match(outerTag, /aria-label=\{getFolderGroupLabel\(name\)\}/);
  assert.doesNotMatch(outerTag, /onClick|onKeyDown|tabIndex/);
  assert.ok(openStart > 0 && openEnd < renameStart && renameStart < deleteStart);
  assert.match(openButton, /type="button"/);
  assert.match(openButton, /aria-label=\{getFolderOpenLabel\(name, count\)\}/);
  assert.match(openButton, /disabled=\{interactionDisabled\}/);
  assert.match(openButton, /onClick=\{onClick\}/);
  assert.doesNotMatch(openButton, /onKeyDown|onKeyUp/);
  assert.match(card.slice(renameStart, deleteStart), /e\.stopPropagation\(\)/);
  assert.match(card.slice(deleteStart), /e\.stopPropagation\(\)/);
  assert.doesNotMatch(card.slice(renameStart, deleteStart), /onClick=\{onClick\}/);
  assert.doesNotMatch(card.slice(deleteStart), /onClick=\{onClick\}/);
  assert.match(headerCss, /\.folder-card-open:focus-visible[\s\S]{0,160}outline:/);
  assert.match(headerCss, /\.folder-card-(rename|delete)-btn:focus-visible/);
});

test("authenticated shell owns token-safe rename lifecycle, workspace abort, and all departure guards", () => {
  assert.match(app, /useState<FolderRenameOperation \| null>/);
  assert.match(app, /useRef<FolderRenameGate>/);
  assert.match(app, /beginFolderRename/);
  assert.match(app, /finishFolderRename/);
  assert.match(app, /abortFolderRenameForWorkspaceDrift/);
  assert.match(app, /renameFolderApi\([\s\S]*oldFolder,[\s\S]*newFolder,[\s\S]*currentGroupId \|\| undefined,[\s\S]*controller\.signal/);
  assert.match(app, /const fetchPhotosRef = useRef\(fetchPhotos\);[\s\S]*fetchPhotosRef\.current = fetchPhotos/);
  assert.match(app, /workspaceChanged[\s\S]*await fetchPhotosRef\.current\(\)/);
  assert.match(app, /catch \(e\)[\s\S]*phase: "reconciling"[\s\S]*await fetchPhotosRef\.current\(\)[\s\S]*throw e/);
  assert.match(app, /const transferring =[\s\S]*folderRenameOperation !== null/);
  assert.match(app, /const switchTab = \(tab: ViewTab\) => \{[\s\S]*blockIfTransferring\(\)/);
  assert.match(app, /<GroupSwitcher[\s\S]*disabled=\{transferring\}/);
  assert.match(app, /window\.addEventListener\("beforeunload", onBeforeUnload\)/);
  assert.match(app, /activatePwaUpdate\(window as PwaUpdateBrowserWindow, \{ transferring \}\)/);
  assert.match(app, /folderRenameActive=\{folderRenameOperation !== null\}/);
  assert.match(app, /const openSettingsTab =[\s\S]*if \(folderRenameGate\.current\)[\s\S]*return;/);
  assert.match(app, /const openSettingsFromUserMenu =[\s\S]*if \(folderRenameGate\.current\)[\s\S]*return;/);
  assert.match(app, /className="user-menu-item"[\s\S]{0,180}disabled=\{folderRenameOperation !== null\}/);
});

test("rename banner names both folders without inventing progress", () => {
  assert.match(app, /正在重命名文件夹[\s\S]*oldLabel[\s\S]*→[\s\S]*newLabel/);
  assert.doesNotMatch(app, /folderRenameOperation[\s\S]{0,220}(percent|%)/);
});

test("authenticated Header install marker, CSS, and component placement remain unchanged", () => {
  assert.doesNotMatch(app, /header-install-button|顶部安装/);
  assert.doesNotMatch(headerCss, /\.header-install-button/);
  assert.match(app, /<header className="app-header">[\s\S]*<GroupSwitcher/);
});
