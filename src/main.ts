import * as fs from "fs/promises";
import { MarkdownView, Plugin, TFile } from "obsidian";
import * as os from "os";
import * as path from "path";

import * as electron from "electron";
import { WebviewTag } from "electron";
import { editPDF } from "./pdf";
import { waitFor } from "./utils";

import { ExportConfigModal, TConfig } from "./modal";
import ConfigSettingTab from "./setting";
import { renderFile } from "./render";

const isDev = process.env.NODE_ENV === "development";

interface BetterExportPdfPluginSettings {
  pageFormat: string;
  distance: string;
  prevConfig?: TConfig;
}

const DEFAULT_SETTINGS: BetterExportPdfPluginSettings = {
  pageFormat: "{page}",
  distance: "15",
};

export default class BetterExportPdfPlugin extends Plugin {
  settings: BetterExportPdfPluginSettings;

  async onload() {
    await this.loadSettings();

    this.registerCommand();
    this.registerSetting();
    this.registerEvents();
  }

  registerCommand() {
    this.addCommand({
      id: "export-current-file-to-pdf",
      name: "Export Current file to PDF",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!file) {
          return;
        }
        if (checking) {
          return true;
        }
        new ExportConfigModal(
          this.app,
          async (config: TConfig) => {
            try {
              await this.exportToPDF(file, config);
            } catch (error) {
              console.error(error);
            } finally {
              document.querySelectorAll("webview").forEach((node) => {
                console.log("webview");
                if (!isDev) {
                  node.parentNode?.removeChild(node);
                }
              });
            }
          },
          this.settings?.prevConfig,
        ).open();

        return true;
      },
    });
  }

  registerSetting() {
    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new ConfigSettingTab(this.app, this));
  }

  registerEvents() {
    // Register the Export As HTML button in the file menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file: TFile) => {
        menu.addItem((item) => {
          let title = "Better to PDF";
          if (isDev) {
            title = `${title} (dev)`;
          }
          item
            .setTitle(title)
            .setIcon("download")
            .setSection("action")
            .onClick(async () => {
              new ExportConfigModal(
                this.app,
                async (config: TConfig) => {
                  try {
                    this.settings.prevConfig = config;
                    await this.saveSettings();
                    await this.exportToPDF(file, config);
                  } catch (error) {
                    console.error(error);
                  } finally {
                    document.querySelectorAll("webview").forEach((node) => {
                      console.log("webview");
                      if (!isDev) {
                        node.parentNode?.removeChild(node);
                      }
                    });
                  }
                },
                this.settings?.prevConfig,
              ).open();
            });
        });
      }),
    );
  }
  onunload() {}
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async exportToPDF(file: TFile, config: TConfig) {
    console.log("export to pdf:", config);

    const printOptions: electron.PrintToPDFOptions = {
      footerTemplate: '<div><span class="pageNumber"></span></div>',
      pageSize: config["pageSise"],
      ...config,
      scale: config["scale"] / 100,
      margins: {
        marginType: "default",
      },
    };

    if (config.marginType == "3") {
      // Custom Margin
      printOptions["margins"] = {
        marginType: "custom",
        top: parseFloat(config["marginTop"] ?? "0"),
        bottom: parseFloat(config["marginBottom"] ?? "0"),
        left: parseFloat(config["marginLeft"] ?? "0"),
        right: parseFloat(config["marginRight"] ?? "0"),
      };
    }

    console.log(printOptions);

    // @ts-ignore
    const result = await electron.remote.dialog.showSaveDialog({
      title: "Export to PDF",
      defaultPath: file.basename + ".pdf",
      filters: [
        { name: "All Files", extensions: ["*"] },
        { name: "PDF", extensions: ["pdf"] },
      ],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });

    if (result.canceled) {
      return;
    }

    const outputFile = result.filePath;

    const tempRoot = path.join(os.tmpdir(), "Obdisian");
    try {
      await fs.mkdir(tempRoot, { recursive: true });
    } catch (error) {
      /* empty */
    }

    const tempPath = await fs.mkdtemp(path.join(tempRoot, "export"));
    try {
      await fs.mkdir(tempPath, { recursive: true });
    } catch (error) {
      /* empty */
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView;

    const preview = view.previewMode;
    // @ts-ignore
    preview.renderer.showAll = true;
    // @ts-ignore
    await preview.renderer.unfoldAllHeadings();

    const webview = document.createElement("webview");
    // webview.addClass("print-preview");
    const doc = await renderFile(this, file, tempPath, config);

    console.log(file);

    const tempFile = path.join(tempPath, "index.html");
    console.log("temp html file:", tempFile);

    const html = `<html>${doc.documentElement.innerHTML}</html>`;
    await fs.writeFile(tempFile, html);

    // TODO: try inline css in order to debug pagedjs
    // const inlineHtml = juice(html);
    // await fs.writeFile(path.join(tempPath, "inline-index.html"), inlineHtml);

    webview.src = `file:///${tempFile}`;
    webview.nodeintegration = true;

    let completed = false;
    document.body.appendChild(webview);
    webview.addEventListener("dom-ready", (e) => {
      console.log("dom-ready");
      completed = true;
    });

    await waitFor(() => completed);

    const w = document.querySelector("webview:last-child") as WebviewTag;
    console.log("webviewID", w.getWebContentsId());
    // w.openDevTools();
    await sleep(5000); // 5s
    try {
      let data = await w.printToPDF(printOptions);

      data = await editPDF(data, doc, {
        format: this.settings.pageFormat,
        position: parseFloat(this.settings.distance) || parseFloat(config["marginBottom"] ?? "30") / 2,
      });

      await fs.writeFile(outputFile, data);

      if (config.open) {
        // @ts-ignore
        electron.remote.shell.openPath(outputFile);
      }
    } catch (error) {
      console.log(error);
    }
    console.log("finished");
  }

  changeConfig() {
    // @ts-ignore
    const theme = "obsidian" === this.app.vault?.getConfig("theme");
    if (theme) {
      document.body.addClass("theme-light");
      document.body.removeClass("theme-dark");
    }
    document.body.removeClass("theme-dark");
    const node = document.body.createDiv("print");

    const reset = function () {
      node.detach();
      if (theme) {
        document.body.removeClass("theme-light");
        document.body.addClass("theme-dark");
      }
      // t.hide();
    };
    node.addEventListener("click", reset);

    const el = document.body.createDiv("print");

    const el2 = el.createDiv("markdown-preview-view markdown-rendered");

    // @ts-ignore
    el2.toggleClass("rtl", this.app.vault.getConfig("rightToLeft"));
    // @ts-ignore
    el2.toggleClass("show-frontmatter", this.app.vault.getConfig("showFrontmatter"));

    el2.createEl("h1", {
      text: "xxxxx", // a.basename
    });
  }
}
