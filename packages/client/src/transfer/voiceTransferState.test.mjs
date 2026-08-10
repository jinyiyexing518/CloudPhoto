import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createInitialVoiceTransferStates,
  getActiveVoiceTransferState,
  isVoiceTransferStateActive,
  setVoiceTransferState,
} from "./voiceTransferState.ts";

test("treats recording and uploading as active voice transfer states", () => {
  assert.equal(isVoiceTransferStateActive("idle"), false);
  assert.equal(isVoiceTransferStateActive("recording"), true);
  assert.equal(isVoiceTransferStateActive("uploading"), true);
});

test("tracks timeline/moments/folder independently and release is source-scoped", () => {
  let states = createInitialVoiceTransferStates();
  states = setVoiceTransferState(states, "timeline", "recording");
  states = setVoiceTransferState(states, "moments", "uploading");
  assert.equal(getActiveVoiceTransferState(states), "recording");

  states = setVoiceTransferState(states, "timeline", "idle");
  assert.equal(getActiveVoiceTransferState(states), "uploading");

  states = setVoiceTransferState(states, "moments", "idle");
  assert.equal(getActiveVoiceTransferState(states), "idle");
});

test("authenticated app contract uses one derived transferring guard for tab/group/pwa", () => {
  const source = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
  assert.match(source, /const transferring =[\s\S]*voiceTransferState !== "idle"/);
  assert.match(source, /const switchTab = useCallback\(\(tab: ViewTab\) => \{[\s\S]*blockIfTransferring\(\)/);
  assert.match(source, /<GroupSwitcher[\s\S]*onBeforeSelect=\{handleGroupSwitch\}[\s\S]*disabled=\{transferring\}/);
  assert.match(source, /setDangerousOperationActivity\(\s*"authenticated-app",\s*transferring/);
  assert.match(source, /activatePwaUpdate\(window as PwaUpdateBrowserWindow\)/);
});

test("voice transfer banner contract distinguishes recording, voice upload, and download", () => {
  const source = readFileSync(new URL("../AuthenticatedApp.tsx", import.meta.url), "utf8");
  assert.match(source, /录音中，请先结束录音/);
  assert.match(source, /语音备注上传中，请勿关闭页面/);
  assert.match(source, /下载中，请勿关闭页面/);
});

test("gallery and folder views report voice state and cleanup to idle", () => {
  const gallery = readFileSync(new URL("../components/gallery/PhotoGallery.tsx", import.meta.url), "utf8");
  const folder = readFileSync(new URL("../components/gallery/FolderView.tsx", import.meta.url), "utf8");
  assert.match(gallery, /onVoiceStateChange\?: \(state: VoiceTransferState\) => void;/);
  assert.match(gallery, /onVoiceStateChange\?\.\(voiceState\);[\s\S]*return \(\) => onVoiceStateChange\?\.\("idle"\);/);
  assert.match(folder, /onVoiceStateChange\?: \(state: VoiceTransferState\) => void;/);
  assert.match(folder, /onVoiceStateChange=\{onVoiceStateChange\}/);
  assert.match(folder, /onVoiceStateChange\?\.\(voiceState\);[\s\S]*return \(\) => onVoiceStateChange\?\.\("idle"\);/);
});
