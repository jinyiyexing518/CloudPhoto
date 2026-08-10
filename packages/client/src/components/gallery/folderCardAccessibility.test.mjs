import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./folderCardAccessibility.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const {
  UNCATEGORIZED_FOLDER_LABEL,
  getFolderDisplayName,
  getFolderGroupLabel,
  getFolderOpenLabel,
} = await import(moduleUrl);

test("folder labels retain meaningful empty, long, and emoji names", () => {
  assert.equal(getFolderDisplayName(""), UNCATEGORIZED_FOLDER_LABEL);
  assert.equal(getFolderDisplayName("   "), UNCATEGORIZED_FOLDER_LABEL);
  assert.equal(getFolderOpenLabel("", 0), "打开文件夹 (未分类)，0 张照片");
  assert.equal(getFolderOpenLabel("  📷 家庭回忆  ", 12), "打开文件夹 📷 家庭回忆，12 张照片");

  const longName = `旅行-${"山海".repeat(40)}-🌏`;
  assert.equal(getFolderGroupLabel(longName), `文件夹 ${longName}`);
  assert.equal(getFolderOpenLabel(longName, 215), `打开文件夹 ${longName}，215 张照片`);
});
