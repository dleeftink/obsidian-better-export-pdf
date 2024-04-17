import { MarkdownRenderer, MarkdownView, TFile, Component, Notice, App, FrontMatterCache, TFolder } from "obsidian";
import { TConfig } from "./modal";
import { copyAttributes, fixAnchors, modifyDest, waitFor } from "./utils";

export function getAllStyles() {
  const cssTexts: string[] = [];

  Array.from(document.styleSheets).forEach((sheet) => {
    // @ts-ignore
    const id = sheet.ownerNode?.id;

    // <style id="svelte-xxx" ignore
    if (id?.startsWith("svelte-")) {
      return;
    }
    // @ts-ignore
    const href = sheet.ownerNode?.href;

    const division = `/* ----------${id ? `id:${id}` : href ? `href:${href}` : ""}---------- */`;

    cssTexts.push(division);

    try {
      Array.from(sheet?.cssRules ?? []).forEach((rule) => {
        cssTexts.push(rule.cssText);
      });
    } catch (error) {
      console.error(error);
    }
  });

  cssTexts.push(...getPatchStyle());
  return cssTexts;
}

const CSS_PATCH = `
/* ---------- css patch ---------- */

body {
  overflow: auto !important;
}
@media print {
  .print .markdown-preview-view {
    height: auto !important;
  }
  .md-print-anchor, .blockid {
    white-space: pre !important;
    border-left: none !important;
    border-right: none !important;
    border-top: none !important;
    border-bottom: none !important;
    display: inline-block !important;
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    right: 0 !important;
    outline: 0 !important;
    background: 0 0 !important;
    text-decoration: initial !important;
    text-shadow: initial !important;
  }
}
@media print {
  table {
    break-inside: auto;
  }
  tr {
    break-inside: avoid;
    break-after: auto;
  }
}
`;

export function getPatchStyle() {
  return [CSS_PATCH, ...getPrintStyle()];
}

export function getPrintStyle() {
  const cssTexts: string[] = [];
  Array.from(document.styleSheets).forEach((sheet) => {
    try {
      const cssRules = sheet?.cssRules ?? [];
      Array.from(cssRules).forEach((rule) => {
        if (rule.constructor.name == "CSSMediaRule") {
          if ((rule as CSSMediaRule).conditionText === "print") {
            const res = rule.cssText.replace(/@media print\s*\{(.+)\}/gms, "$1");
            cssTexts.push(res);
          }
        }
      });
    } catch (error) {
      console.error(error);
    }
  });
  return cssTexts;
}

function generateDocId(n: number) {
  return Array.from({ length: n }, () => ((16 * Math.random()) | 0).toString(16)).join("");
}

export type AyncFnType = (...args: unknown[]) => Promise<unknown>;

export function getFrontMatter(app: App, file: TFile) {
  const cache = app.metadataCache.getFileCache(file);
  return cache?.frontmatter ?? ({} as FrontMatterCache);
}

// 逆向原生打印函数
export async function renderMarkdown(
  app: App,
  file: TFile,
  config: TConfig,
  extra?: {
    title?: string;
    file: TFile;
    id?: string;
  },
) {
  const startTime = new Date().getTime();

  const ws = app.workspace;
  if (ws.getActiveFile()?.path != file.path) {
    const leaf = ws.getLeaf();
    await leaf.openFile(file);
  }
  const view = ws.getActiveViewOfType(MarkdownView) as MarkdownView;
  // @ts-ignore
  const data = view?.data ?? ws?.getActiveFileView()?.data ?? ws.activeEditor?.data;
  if (!data) {
    new Notice("data is empty!");
  }

  const frontMatter = getFrontMatter(app, file);

  const cssclasses = [];
  for (const [key, val] of Object.entries(frontMatter)) {
    if (key.toLowerCase() == "cssclass" || key.toLowerCase() == "cssclasses") {
      if (Array.isArray(val)) {
        cssclasses.push(...val);
      } else {
        cssclasses.push(val);
      }
    }
  }

  const comp = new Component();
  comp.load();

  const printEl = document.body.createDiv("print");
  const viewEl = printEl.createDiv({
    cls: "markdown-preview-view markdown-rendered " + cssclasses.join(" "),
  });
  app.vault.cachedRead(file);

  // @ts-ignore
  viewEl.toggleClass("rtl", app.vault.getConfig("rightToLeft"));
  // @ts-ignore
  viewEl.toggleClass("show-properties", "hidden" !== app.vault.getConfig("propertiesInDocument"));

  if (config.showTitle) {
    const h = viewEl.createEl("h1", {
      text: extra?.title ?? file.basename,
    });
    h.id = extra?.id ?? "";
  }

  const cache = app.metadataCache.getFileCache(file);

  const lines = data?.split("\n") ?? [];

  Object.entries(cache?.blocks ?? {}).forEach(([key, c]) => {
    const idx = c.position.end.line;
    lines[idx] = `<span id="^${key}" class="blockid"></span>\n` + lines[idx];
  });

  const promises: AyncFnType[] = [];
  await MarkdownRenderer.render(app, lines.join("\n"), viewEl, file.path, comp);
  // @ts-ignore
  // (app: App: param: T) => T
  // MarkdownPostProcessorContext
  await MarkdownRenderer.postProcess(app, {
    docId: generateDocId(16),
    sourcePath: file.path,
    frontmatter: {},
    promises,
    addChild: function (e: Component) {
      return comp.addChild(e);
    },
    getSectionInfo: function () {
      return null;
    },
    containerEl: viewEl,
    el: viewEl,
    displayMode: true,
  });
  await Promise.all(promises);

  printEl.findAll("a.internal-link").forEach((el: HTMLAnchorElement) => {
    const [title, anchor] = el.dataset.href?.split("#") ?? [];

    if ((!title || title?.length == 0 || title == file.basename) && anchor?.startsWith("^")) {
      return;
    }

    el.removeAttribute("href");
  });
  try {
    await fixWaitRender(data, viewEl);
  } catch (error) {
    console.warn("wait timeout");
  }

  fixCanvasToImage(viewEl);

  const doc = document.implementation.createHTMLDocument("document");
  doc.body.appendChild(printEl.cloneNode(true));

  printEl.detach();
  comp.unload();
  printEl.remove();
  const endTime = new Date().getTime();

  console.log(`render time:${endTime - startTime}ms`);
  return doc;
}

export function fixDoc(doc: Document, title: string) {
  const dest = modifyDest(doc);
  fixAnchors(doc, dest, title);
  fixEmbedSpan(doc);
}

export function fixEmbedSpan(doc: Document) {
  const spans = doc.querySelectorAll("span.markdown-embed");

  spans.forEach((span: HTMLElement) => {
    const newDiv = document.createElement("div");

    copyAttributes(newDiv, span.attributes);

    newDiv.innerHTML = span.innerHTML;

    span.parentNode?.replaceChild(newDiv, span);
  });
}

export async function fixWaitRender(data: string, viewEl: HTMLElement) {
  if (data.includes("```dataview") || data.includes("```gEvent") || data.includes("![[")) {
    await sleep(2000);
  }
  try {
    await waitForDomChange(viewEl);
  } catch (error) {
    await sleep(1000);
  }
}

// TODO: base64 to canvas
// TODO: light render canvas
export function fixCanvasToImage(el: HTMLElement) {
  for (const canvas of Array.from(el.querySelectorAll("canvas"))) {
    const data = canvas.toDataURL();
    const img = document.createElement("img");
    img.src = data;
    copyAttributes(img, canvas.attributes);
    img.className = "__canvas__";

    canvas.replaceWith(img);
  }
}

export function createWebview() {
  const webview = document.createElement("webview");
  webview.src = `app://obsidian.md/help.html`;
  webview.setAttribute(
    "style",
    `height:calc(1/0.75 * 100%);
     width: calc(1/0.75 * 100%);
     transform: scale(0.75, 0.75);
     transform-origin: top left;
     border: 1px solid #f2f2f2;
    `,
  );
  webview.nodeintegration = true;
  return webview;
}

function waitForDomChange(target: HTMLElement, timeout = 2000, interval = 200): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const observer = new MutationObserver((m) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        resolve(true);
      }, interval);
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`timeout ${timeout}ms`));
    }, timeout);
  });
}
