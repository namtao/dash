#!/usr/bin/env node
// Chép bộ icon "Atom Material Icons" (a-file-icon-vscode, MIT) từ extension VS Code đã cài vào public/icons/atom/
// và tạo theme.json gọn: tên file / đuôi / thư mục / ngôn ngữ -> đường dẫn SVG.
// Dùng: node scripts/sync-icons.js [thư mục extension]
const fs = require("fs");
const os = require("os");
const path = require("path");

const extRoot = path.join(os.homedir(), ".vscode/extensions");
const extDir =
  process.argv[2] ||
  fs
    .readdirSync(extRoot)
    .filter((d) => d.startsWith("atommaterial.a-file-icon-vscode-"))
    .sort()
    .map((d) => path.join(extRoot, d))
    .pop();
if (!extDir) {
  console.error("Atom Material Icons extension not found. Pass its folder as the first argument.");
  process.exit(1);
}
const themeFile = path.join(extDir, JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8")).contributes.iconThemes[0].path);
const theme = JSON.parse(fs.readFileSync(themeFile, "utf8"));
const out = path.join(__dirname, "../public/icons/atom");

fs.rmSync(out, { recursive: true, force: true });
const used = new Map(); // id -> đường dẫn tương đối trong public/icons/atom
function iconOf(id) {
  if (!id) return undefined;
  if (used.has(id)) return used.get(id);
  const def = theme.iconDefinitions[id];
  if (!def?.iconPath) return undefined;
  const src = path.resolve(path.dirname(themeFile), def.iconPath);
  if (!fs.existsSync(src)) return used.set(id, undefined), undefined; // icon khai báo nhưng thiếu file
  const rel = path.relative(path.dirname(themeFile), src).replace(/^(\.\.\/)*(dist\/)?/, "");
  fs.mkdirSync(path.join(out, path.dirname(rel)), { recursive: true });
  fs.copyFileSync(src, path.join(out, rel));
  used.set(id, rel);
  return rel;
}
const mapAll = (obj = {}) => Object.fromEntries(Object.entries(obj).map(([k, id]) => [k.toLowerCase(), iconOf(id)]).filter(([, v]) => v));

const compact = {
  file: iconOf(theme.file),
  folder: iconOf(theme.folder),
  folderExpanded: iconOf(theme.folderExpanded),
  rootFolder: iconOf(theme.rootFolder),
  rootFolderExpanded: iconOf(theme.rootFolderExpanded),
  fileNames: mapAll(theme.fileNames),
  fileExtensions: mapAll(theme.fileExtensions),
  folderNames: mapAll(theme.folderNames),
  folderNamesExpanded: mapAll(theme.folderNamesExpanded),
  languageIds: mapAll(theme.languageIds),
  light: { fileNames: mapAll(theme.light?.fileNames), fileExtensions: mapAll(theme.light?.fileExtensions) },
};
fs.writeFileSync(path.join(out, "theme.json"), JSON.stringify(compact));
fs.copyFileSync(path.join(extDir, "LICENSE.md"), path.join(out, "LICENSE"));
console.log(`Copied ${used.size} icons from ${extDir} to ${out}`);
