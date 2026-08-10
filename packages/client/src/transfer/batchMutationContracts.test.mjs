import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
const gallery = readFileSync(new URL("../components/gallery/PhotoGallery.tsx", import.meta.url), "utf8");
const folder = readFileSync(new URL("../components/gallery/FolderView.tsx", import.meta.url), "utf8");
const bar = readFileSync(new URL("../components/shared/BatchOperationsBar.tsx", import.meta.url), "utf8");
const card = readFileSync(new URL("../components/gallery/PhotoCard.tsx", import.meta.url), "utf8");

function handler(source, name, nextName) {
  const start = source.indexOf(`const ${name}`);
  const end = nextName ? source.indexOf(`const ${nextName}`, start + 1) : source.length;
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

test("gallery reports rename, time, and location through a finally-cleared mutation boundary", () => {
  assert.match(gallery, /onBatchMutationChange\?: \(event: BatchMutationEvent\) => void;/);
  assert.match(gallery, /const batchMutationBusy = localBatchMutationBusy \|\| batchMutationActive/);
  assert.match(gallery, /if \(batchMutationActive\) return null;/);
  assert.match(handler(gallery, "handleBatchRename", "handleBatchSetTakenAt"), /executeBatchMutation\("rename"/);
  assert.match(handler(gallery, "handleBatchSetTakenAt", "handleBatchSetGps"), /executeBatchMutation\("time"/);
  assert.match(handler(gallery, "handleBatchSetGps", "handleDownload"), /executeBatchMutation\("location"/);
  assert.match(gallery, /runBatchMutationBoundary\([\s\S]*onEvent:[\s\S]*onBatchMutationChange/);
});

test("folder root passes mutation events to content and all four handlers use the boundary", () => {
  const contentStart = folder.indexOf("function FolderContent");
  const rootSource = folder.slice(0, contentStart);
  const contentSource = folder.slice(contentStart);
  assert.match(folder, /onBatchMutationChange\?: \(event: BatchMutationEvent\) => void;/);
  assert.match(folder, /<FolderContent[\s\S]*onBatchMutationChange=\{handleBatchMutationEvent\}/);
  assert.match(rootSource, /const \[localBatchMutationBusy, setLocalBatchMutationBusy\]/);
  assert.match(rootSource, /const batchMutationBusy = localBatchMutationBusy \|\| batchMutationActive/);
  assert.match(rootSource, /useRef<BatchMutationGate>\(\{ current: null \}\)/);
  assert.match(rootSource, /<FolderContent[\s\S]*batchMutationGate=\{batchMutationGate\}/);
  assert.doesNotMatch(contentSource, /useRef<BatchMutationGate>/);
  assert.match(handler(folder, "handleBatchMove", "handleBatchRename"), /executeBatchMutation\(\s*"move"[\s\S]*concurrency:\s*4/);
  assert.match(handler(folder, "handleBatchRename", "handleBatchSetTakenAt"), /executeBatchMutation\("rename"/);
  assert.match(handler(folder, "handleBatchSetTakenAt", "handleBatchSetGps"), /executeBatchMutation\("time"/);
  assert.match(handler(folder, "handleBatchSetGps", "openModal"), /executeBatchMutation\("location"/);
  assert.doesNotMatch(handler(folder, "handleBatchMove", "handleBatchRename"), /Promise\.all/);
});

test("authenticated app aggregates all three sources into tab, group, unload, and PWA guards", () => {
  assert.match(app, /createInitialBatchMutationStates/);
  assert.match(app, /handleTimelineBatchMutationChange/);
  assert.match(app, /handleMomentsBatchMutationChange/);
  assert.match(app, /handleFolderBatchMutationChange/);
  assert.match(app, /batchMutationActive=\{batchMutationStates\.timeline !== null\}/);
  assert.match(app, /batchMutationActive=\{batchMutationStates\.moments !== null\}/);
  assert.match(app, /batchMutationActive=\{batchMutationStates\.folder !== null\}/);
  assert.match(app, /const transferring =[\s\S]*activeBatchMutation !== null/);
  assert.match(app, /const switchTab = \(tab: ViewTab\) => \{[\s\S]*blockIfTransferring\(\)/);
  assert.match(app, /<GroupSwitcher[\s\S]*disabled=\{transferring\}/);
  assert.match(app, /window\.addEventListener\("beforeunload", onBeforeUnload\)/);
  assert.match(app, /setDangerousOperationActivity\(\s*"authenticated-app",\s*transferring/);
  assert.match(app, /activatePwaUpdate\(window as PwaUpdateBrowserWindow\)/);
  assert.match(app, /batchMutationActiveRef\.current = activeBatchMutation !== null/);
  assert.match(app, /const fetchPhotos = useCallback\(async \(\) => \{\s*if \(batchMutationActiveRef\.current\) return;/);
  assert.match(app, /e\.key === "r"[\s\S]*blockIfTransferring\(\)[\s\S]*fetchPhotos\(\)/);
  assert.match(app, /if \(activeBatchMutation \|\| !refreshAfterBatchMutationRef\.current\) return;[\s\S]*void fetchPhotos\(\)/);
  assert.match(app, /const handleUploadToFolder = async[\s\S]*if \(batchMutationActiveRef\.current\)/);
  assert.match(app, /const onPaste =[\s\S]*if \(batchMutationActiveRef\.current\)[\s\S]*uploadToFolderRef\.current/);
});

test("batch banner and guard identify operation, progress, failure count, and percentage", () => {
  assert.match(app, /getBatchMutationLabel\(activeBatchMutation\.kind\)/);
  assert.match(app, /activeBatchMutation\.done/);
  assert.match(app, /activeBatchMutation\.total/);
  assert.match(app, /activeBatchMutation\.failed/);
  assert.match(app, /getBatchMutationPercent\(activeBatchMutation\)/);
  assert.match(app, /getBatchMutationLabel\(activeBatchMutation\.kind\)}进行中/);
});

test("batch operations expose semantic busy and disabled state for conflicting controls", () => {
  assert.match(bar, /busy:\s*boolean;/);
  assert.match(bar, /aria-busy=\{busy\}/);
  assert.ok((bar.match(/disabled=\{busy/g) ?? []).length >= 8);
  assert.match(bar, /saving=\{busy\}/);
  assert.match(folder, /<BatchOperationsBar[\s\S]*busy=\{batchMutationBusy\}/);
  assert.match(folder, /className="modal-move-select"[\s\S]*disabled=\{batchMutationBusy\}/);
  assert.match(folder, /确认移动[\s\S]*disabled=\{batchMutationBusy\}/);
  assert.match(folder, /title="上传原图到当前文件夹"[\s\S]*disabled=\{anyUploading \|\| batchMutationBusy\}/);
  assert.match(gallery, /<BatchOperationsBar[\s\S]*busy=\{batchMutationBusy\}/);
  assert.match(gallery, /className="moments-card"[\s\S]*tabIndex=\{batchMutationBusy \? -1 : 0\}[\s\S]*aria-disabled=\{batchMutationBusy \|\| undefined\}[\s\S]*if \(batchMutationBusy\) return;/);
  assert.match(gallery, /className="date-group-select-all"[\s\S]*disabled=\{batchMutationBusy\}/);
  assert.match(gallery, /if \(!selectMode \|\| selectedIdx !== null \|\| batchMutationBusy\) return;/);
  assert.match(gallery, /interactionDisabled=\{batchMutationBusy\}/);
  assert.match(folder, /interactionDisabled=\{batchMutationBusy\}/);
  assert.match(folder, /onRename=\{onRenameSubFolder \?/);
  assert.match(folder, /onDelete=\{onDeleteSubFolder \?/);
  assert.match(folder, /interactionDisabled=\{batchMutationBusy\}/);
  assert.match(folder, /onDrop=\{batchMutationBusy \? undefined/);
  assert.match(card, /aria-disabled=\{interactionDisabled \|\| undefined\}/);
  assert.match(card, /if \(interactionDisabled\) return;/);
  assert.match(card, /\{!onSelect && !interactionDisabled && \(/);
});
