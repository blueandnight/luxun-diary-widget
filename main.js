const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, screen, session } = require("electron");
const fs = require("fs");
const path = require("path");

const SITE = "https://blueandnight.github.io/luxun-diary/";
const APP_TITLE = "鲁迅日记·百年前的今天";
const ICON = path.join(__dirname, "assets", "icon.png");
const STATE_FILE = () => path.join(app.getPath("userData"), "widget-state.json");

let win = null;
let tray = null;
let isQuitting = false;
let pinned = true;
let saveTimer = null;

function readState() {
  try {
    return { width: 640, height: 820, alwaysOnTop: true, ...JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) };
  } catch {
    return { width: 640, height: 820, alwaysOnTop: true };
  }
}

function saveState() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const bounds = win.getBounds();
      fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
      fs.writeFileSync(STATE_FILE(), JSON.stringify({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        alwaysOnTop: pinned
      }, null, 2));
    } catch {
      // Window state is a convenience, never a reason to fail startup.
    }
  }, 150);
}

function getVisibleBounds(state) {
  const display = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(state.width || 640, 380), display.width);
  const height = Math.min(Math.max(state.height || 820, 520), display.height);
  let x = Number.isInteger(state.x) ? state.x : display.x + display.width - width - 28;
  let y = Number.isInteger(state.y) ? state.y : display.y + Math.max(24, Math.round((display.height - height) / 2));
  const visible = screen.getAllDisplays().some(({ workArea: area }) =>
    x + width > area.x + 40 && x < area.x + area.width - 40 &&
    y + height > area.y + 40 && y < area.y + area.height - 40
  );
  if (!visible) {
    x = display.x + display.width - width - 28;
    y = display.y + Math.max(24, Math.round((display.height - height) / 2));
  }
  return { x, y, width, height };
}

function setPinned(value) {
  pinned = Boolean(value);
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(pinned, "floating");
    win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('[data-lxw="pin"]'); if (b) b.classList.toggle('is-active', ${pinned}); })()`
    ).catch(() => {});
  }
  saveState();
  updateTrayMenu();
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

function openFullSite() {
  shell.openExternal(SITE);
}

function openExternalSafely(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    const allowedHosts = new Set([
      "www.luxunmuseum.com.cn",
      "luxunmuseum.com.cn",
      "zh.wikisource.org",
      "github.com",
      "blueandnight.github.io"
    ]);
    if (!allowedHosts.has(parsed.hostname)) return;
    shell.openExternal(parsed.toString());
  } catch {
    // Ignore malformed or non-web URLs.
  }
}

function hardenSession() {
  // The reader needs no camera, microphone, location, notifications, or
  // filesystem permissions. Only allow clipboard writes for "复制本日链接".
  const isAllowed = (permission) => permission === "clipboard-sanitized-write";
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isAllowed(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => isAllowed(permission));
}

function isWidgetSender(event) {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
}

function reloadSite() {
  if (!win || win.isDestroyed()) return;
  win.loadURL(SITE).catch(() => {});
}

function showLoadError(message) {
  if (!win || win.isDestroyed()) return;
  const safe = String(message || "网络连接失败").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      html,body{height:100%;margin:0;background:#f4f0e7;color:#2f4b3f;font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif}
      body{display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box}
      .card{max-width:380px;border:1px solid #d8d2c4;background:#faf7ef;padding:22px;line-height:1.8}
      h1{font-size:17px;margin:0 0 8px}p{font-size:13px;color:#726b5d;margin:0 0 16px}
      button{border:1px solid #2f4b3f;background:#2f4b3f;color:#f4f0e7;padding:8px 14px;cursor:pointer;font:inherit}
      button.secondary{background:transparent;color:#2f4b3f;margin-left:6px}
    </style></head><body><main class="card">
      <h1>暂时无法载入日记页面</h1>
      <p>${safe}<br>桌面浮窗需要连接 GitHub Pages。请检查网络后重试。</p>
      <button id="retry">重试</button><button id="browser" class="secondary">用浏览器打开</button>
    </main><script>
      document.getElementById("retry").addEventListener("click", () => window.lxWidget.reload());
      document.getElementById("browser").addEventListener("click", () => window.lxWidget.openFull());
    </script></body></html>`;
  win.loadURL("data:text/html;charset=UTF-8," + encodeURIComponent(html)).catch(() => {});
}

async function injectShell() {
  if (!win || win.isDestroyed()) return;
  const css = `
    #lxw-bar{position:fixed;top:0;left:0;right:0;height:38px;z-index:2147483647;
      display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;
      padding:0 0 0 12px;background:#f4f0e7;border-bottom:1px solid #d8d2c4;
      -webkit-app-region:drag;user-select:none;font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif}
    #lxw-brand{display:flex;align-items:baseline;gap:8px;color:#2f4b3f;white-space:nowrap;overflow:hidden}
    #lxw-mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;
      border:1px solid #2f4b3f;color:#2f4b3f;font-size:13px;font-weight:600;transform:translateY(1px)}
    #lxw-name{font-size:12px;font-weight:600;letter-spacing:.04em}
    #lxw-sub{font-size:10px;color:#8b8375;letter-spacing:.04em}
    #lxw-actions{display:flex;align-items:center;height:100%;-webkit-app-region:no-drag}
    #lxw-actions button{height:100%;min-width:34px;border:0;border-left:1px solid rgba(216,210,196,.65);
      background:transparent;color:#6f6759;font:11px "Microsoft YaHei UI","Microsoft YaHei",sans-serif;
      cursor:pointer;padding:0 9px}
    #lxw-actions button:hover{background:rgba(47,75,63,.08);color:#2f4b3f}
    #lxw-actions button.is-active{color:#2f4b3f;font-weight:600}
    body{padding-top:38px !important;box-sizing:border-box}
    header.topbar{top:38px !important}
    html{overscroll-behavior:none}
  `;
  try {
    await win.webContents.insertCSS(css, { cssOrigin: "author" });
    await win.webContents.executeJavaScript(`(() => {
      if (document.getElementById("lxw-bar")) return;
      const bar = document.createElement("div");
      bar.id = "lxw-bar";
      bar.innerHTML = '<div id="lxw-brand"><span id="lxw-mark">迅</span><span id="lxw-name">鲁迅日记</span><span id="lxw-sub">百年前的今天</span></div>' +
        '<div id="lxw-actions">' +
        '<button data-lxw="pin" class="${pinned ? "is-active" : ""}" title="切换置顶">置顶</button>' +
        '<button data-lxw="open" title="打开完整网站">↗</button>' +
        '<button data-lxw="min" title="最小化">—</button>' +
        '<button data-lxw="hide" title="收起到托盘">×</button>' +
        '</div>';
      document.documentElement.appendChild(bar);
      bar.querySelector('[data-lxw="pin"]').addEventListener("click", async () => {
        const value = await window.lxWidget.togglePin();
        bar.querySelector('[data-lxw="pin"]').classList.toggle("is-active", value);
      });
      bar.querySelector('[data-lxw="open"]').addEventListener("click", () => window.lxWidget.openFull());
      bar.querySelector('[data-lxw="min"]').addEventListener("click", () => window.lxWidget.minimize());
      bar.querySelector('[data-lxw="hide"]').addEventListener("click", () => window.lxWidget.hide());
    })()`);
    await win.webContents.executeJavaScript("window.scrollTo(0, 0)").catch(() => {});
  } catch {
    // A navigation teardown can race with injection; the next load retries.
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const autoStart = app.isPackaged ? app.getLoginItemSettings().openAtLogin : false;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 / 隐藏", click: toggleWindow },
    { label: "置顶显示", type: "checkbox", checked: pinned, click: (item) => setPinned(item.checked) },
    { label: "刷新", click: reloadSite },
    { label: "打开完整网站", click: openFullSite },
    { type: "separator" },
    {
      label: "开机启动",
      type: "checkbox",
      checked: autoStart,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true })
    },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(APP_TITLE);
  tray.on("click", toggleWindow);
  updateTrayMenu();
}

function createWindow() {
  const state = readState();
  pinned = state.alwaysOnTop !== false;
  const bounds = getVisibleBounds(state);
  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 520,
    frame: false,
    resizable: true,
    show: false,
    title: APP_TITLE,
    icon: ICON,
    backgroundColor: "#f4f0e7",
    alwaysOnTop: pinned,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.setAlwaysOnTop(pinned, "floating");
  win.setMenuBarVisibility(false);
  win.loadURL(SITE).catch(() => {});

  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    if (!win.isDestroyed()) win.setTitle(APP_TITLE);
  });
  win.webContents.on("did-finish-load", () => {
    injectShell();
  });
  win.webContents.on("did-fail-load", (event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || String(url).startsWith("data:text/html")) return;
    showLoadError(description);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url === SITE || url.startsWith(SITE) || String(url).startsWith("data:text/html")) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.on("resize", saveState);
  win.on("move", saveState);
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => { win = null; });
  win.once("ready-to-show", () => win.show());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setName("鲁迅日记");
  app.setAppUserModelId("com.blueandnight.luxundiary");
  app.on("second-instance", showWindow);
  app.on("before-quit", () => { isQuitting = true; saveState(); });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    hardenSession();
    createTray();
    createWindow();
    ipcMain.handle("widget:hide", (event) => { if (isWidgetSender(event)) win.hide(); });
    ipcMain.handle("widget:minimize", (event) => { if (isWidgetSender(event)) win.minimize(); });
    ipcMain.handle("widget:toggle-pin", (event) => {
      if (!isWidgetSender(event)) return pinned;
      setPinned(!pinned);
      return pinned;
    });
    ipcMain.handle("widget:is-pinned", (event) => isWidgetSender(event) ? pinned : false);
    ipcMain.handle("widget:reload", (event) => { if (isWidgetSender(event)) reloadSite(); });
    ipcMain.handle("widget:open-full", (event) => { if (isWidgetSender(event)) openFullSite(); });
    app.on("activate", showWindow);
  });
  app.on("window-all-closed", () => {
    // Keep running in the tray.
  });
}
