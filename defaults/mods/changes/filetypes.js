// Files and Changes keep identical helpers so each mod can load within its own folder.
import { image } from "gpui-kit";
import theme from "./symbols-theme.js";

const { fileNames, fileExtensions, folderNames, iconDefinitions } = theme;

function leaf(path) {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

function iconPath(id) {
  return "mods/files/symbols/" + iconDefinitions[id].iconPath.slice(2);
}

export function fileIconPath(path) {
  const name = leaf(path);
  if (Object.hasOwn(fileNames, name)) return iconPath(fileNames[name]);

  // A compound suffix like d.ts takes priority over ts.
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const suffix = name.slice(dot + 1);
    if (Object.hasOwn(fileExtensions, suffix)) return iconPath(fileExtensions[suffix]);
  }
  return iconPath(theme.file);
}

export function folderIconPath(path) {
  const name = leaf(path);
  return iconPath(Object.hasOwn(folderNames, name) ? folderNames[name] : theme.folder);
}

export function fileIcon(path) {
  return image(fileIconPath(path)).size(16).flex_none();
}

export function folderIcon(path) {
  return image(folderIconPath(path)).size(16).flex_none();
}
