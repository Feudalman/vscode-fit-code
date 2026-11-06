/* ---------------------------------------------------------------
   FitCode — 官网脚本。三件事：演示布局、渲染设置表、中英切换。
   HTML 里的文案就是中文原文；这里只放英文，切回中文时用缓存的原文。
   --------------------------------------------------------------- */

(function () {
  "use strict";

  /* ---------------------------------------------------------------
     1. 演示：真实地按"面板宽 − 行号 − minimap − 滚动条 − 最长行"
     算一次 pad，和扩展里的算法同构。
     --------------------------------------------------------------- */

  var FILES = [
    {
      name: "notes.md",
      cursor: 4,
      lines: [
        "# FitCode",
        "",
        "Center the text when it fits,",
        "fill the panel when it does not.",
        "",
        "- width follows the longest line",
        "- no thresholds to configure",
        "- per editor group, independently",
        "",
        "Line numbers fade, the text stays put.",
      ],
    },
    {
      name: "metrics.tsv",
      cursor: 2,
      lines: [
        "dataset         rows       bytes        p50(ms)  p95(ms)  p99(ms)  max(ms)  errors  status    host     disk",
        "trades_2024     1284432    3321422331   12.4     48.9     132.7    1204.8   0       ok        core-01  nvme0n1",
        "quotes_2024     8821440    10527122900  31.2     104.6    287.3    3910.2   7       lagging   core-02  nvme0n1",
        "orders_2024     2410776    1288990112   8.9      22.1     61.4     402.7    2       ok        core-01  nvme0n1",
        "fills_2024      4410228    5799128311   15.7     63.2     198.8    1588.4   1       ok        edge-03  nvme1n2",
        "books_2024      9930155    13532201144  44.8     188.2    512.6    7201.9   23      degraded  edge-04  nvme1n2",
      ],
    },
  ];

  var state = { file: 0, mode: "on" };

  var panel = document.getElementById("demo-panel");
  var gutterEl = document.getElementById("demo-gutter");
  var scrollEl = document.getElementById("demo-scrollable");
  var codeEl = document.getElementById("demo-code");
  var renameEl = document.getElementById("demo-file");
  var padL = document.getElementById("demo-pad-l");
  var padR = document.getElementById("demo-pad-r");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".demo-tab"));
  var modeButtons = Array.prototype.slice.call(
    document.querySelectorAll(".demo-switch button"),
  );

  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d");
  var metricCache = { font: "", widths: Object.create(null) };

  function textWidth(str) {
    var cs = getComputedStyle(codeEl);
    var font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    if (font !== metricCache.font) {
      metricCache = { font: font, widths: Object.create(null) };
    }
    if (!(str in metricCache.widths)) {
      ctx.font = font;
      metricCache.widths[str] = ctx.measureText(str).width;
    }
    return metricCache.widths[str];
  }

  function renderFile() {
    var file = FILES[state.file];
    var frag = document.createDocumentFragment();
    var gutterFrag = document.createDocumentFragment();

    file.lines.forEach(function (line, i) {
      var row = document.createElement("div");
      row.className = "ln" + (i === file.cursor ? " is-cursor" : "");
      row.textContent = line || "\u00a0";
      frag.appendChild(row);

      var num = document.createElement("span");
      num.textContent = i + 1;
      if (i === file.cursor) num.className = "is-cursor";
      gutterFrag.appendChild(num);
    });

    codeEl.replaceChildren(frag);
    gutterEl.replaceChildren(gutterFrag);
    renameEl.textContent = file.name;
    tabs.forEach(function (tab) {
      tab.setAttribute(
        "aria-selected",
        Number(tab.dataset.file) === state.file ? "true" : "false",
      );
    });
  }

  function numberFromVar(cs, name, fallback) {
    var value = parseFloat(cs.getPropertyValue(name));
    return isFinite(value) ? value : fallback;
  }

  function layout() {
    if (!panel || !panel.clientWidth) return;

    var cs = getComputedStyle(panel);
    var gutter = numberFromVar(cs, "--gutter", 46);
    var minimap = numberFromVar(cs, "--minimap", 44);
    var scroll = numberFromVar(cs, "--scroll", 10);
    var avail = Math.max(0, panel.clientWidth - gutter - minimap - scroll);

    var file = FILES[state.file];
    var longest = file.lines.reduce(function (max, line) {
      return Math.max(max, textWidth(line));
    }, 0);

    var textW = Math.min(avail, Math.ceil(longest));
    var pad = state.mode === "on" ? Math.max(0, (avail - textW) / 2) : 0;

    scrollEl.style.right = "auto";
    scrollEl.style.left = gutter + pad + "px";
    scrollEl.style.width = Math.max(0, avail - pad * 2) + "px";

    padL.style.left = gutter + "px";
    padL.style.width = pad + "px";
    padR.style.right = minimap + scroll + "px";
    padR.style.width = pad + "px";
    padL.style.opacity = padR.style.opacity = pad > 4 ? "1" : "0";

  }

  function sync() {
    modeButtons.forEach(function (btn) {
      btn.setAttribute("aria-pressed", btn.dataset.mode === state.mode ? "true" : "false");
    });
    panel.dataset.mode = state.mode;
    renderFile();
    layout();
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      state.file = Number(tab.dataset.file);
      sync();
    });
  });

  modeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.mode = btn.dataset.mode;
      sync();
    });
  });

  if (panel && "ResizeObserver" in window) {
    new ResizeObserver(layout).observe(panel);
  } else {
    window.addEventListener("resize", layout);
  }
  if (document.fonts && document.fonts.ready.then) {
    document.fonts.ready.then(layout);
  }
  sync();

  /* ---------------------------------------------------------------
     2. 设置表
     --------------------------------------------------------------- */

  var SETTINGS = [
    {
      key: "fitcode.center",
      def: "true",
      zh: ["正文居中。关掉就回到原生布局。", "—"],
      en: ["Center the text. Turn it off to go back to the native layout.", "—"],
    },
    {
      key: "fitcode.lineNumbersOnlyAtCursor",
      def: "true",
      zh: ["行号只显示光标所在行，多光标则每处都显示。", "照常工作"],
      en: ["Show line numbers only on the cursor lines, every cursor when there are several.", "Keeps working"],
    },
    {
      key: "fitcode.animate",
      def: "true",
      zh: ["切文件、改内容时宽度渐变。", "没有效果"],
      en: ["Animate the width when switching files or when the content changes.", "No effect"],
    },
    {
      key: "fitcode.animateDuration",
      def: "140",
      zh: ["渐变时长（ms），0 表示不渐变。", "没有效果"],
      en: ["Animation duration in ms; 0 disables it.", "No effect"],
    },
    {
      key: "fitcode.minTextWidth",
      def: "640",
      zh: ["正文最小宽度（px）。", "没有效果"],
      en: ["Minimum text width in px.", "No effect"],
    },
    {
      key: "fitcode.paddingRight",
      def: "20",
      zh: ["正文右侧额外留白（px）。", "没有效果"],
      en: ["Extra padding on the right of the text, in px.", "No effect"],
    },
    {
      key: "fitcode.cacheSize",
      def: "300",
      zh: ["每个文件缓存多少条宽度。", "没有效果"],
      en: ["How many widths to cache per file.", "No effect"],
    },
  ];

  var settingsBody = document.getElementById("settings-body");

  function renderSettings(lang) {
    if (!settingsBody) return;
    var frag = document.createDocumentFragment();
    SETTINGS.forEach(function (row) {
      var cells = [row.key, row.def].concat(lang === "zh" ? row.zh : row.en);
      var tr = document.createElement("tr");
      cells.forEach(function (text, i) {
        var td = document.createElement("td");
        if (i === 0) {
          var code = document.createElement("code");
          code.textContent = text;
          td.appendChild(code);
        } else {
          td.textContent = text;
        }
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    settingsBody.replaceChildren(frag);
  }

  /* ---------------------------------------------------------------
     3. 文案与语言切换
     --------------------------------------------------------------- */

  var EN = {
    "meta.title": "FitCode — the editor width that follows the content",
    "meta.desc":
      "FitCode is a VS Code extension: the text width follows the content. Narrow files read centered, wide files fill the panel, line numbers move with the text, and the scrollbar and minimap stay where they are.",

    "nav.features": "Features",
    "nav.how": "How it works",
    "nav.install": "Install",
    "nav.settings": "Settings",
    "nav.limits": "Limits",
    "nav.github": "GitHub",

    "hero.badge": "VS Code extension",
    "hero.tagline": "Let the content decide how wide the editor is.",
    "hero.lede":
      "Narrow files read centered, wide files fill the panel. Line numbers follow the text, the scrollbar and minimap stay where they are.",

    "cta.install": "Install",
    "cta.github": "View on GitHub",
    "cta.how": "See how it works",

    "skip": "Skip to content",
    "demo.native": "Native",
    "demo.layoutAria": "Layout",
    "demo.tabsAria": "Files",
    "demo.cap":
      "Click a tab to switch files, click the switch to go back to the native layout. The dashed lines are the pad, the inset on both sides of the text — derived from the longest line, with no threshold to configure.",

    "features.title": "What you get",
    "features.lede":
      "The defaults are the usable state. Everything you might want to change is in the settings, and none of it is entangled.",

    "f1.t": "It finds its own width",
    "f1.b":
      "Every editor reads its own file and measures the longest line (tabs expanded, full-width characters as 2 columns, trailing whitespace ignored). If it fits, the text is centered; if not, it fills the panel and scrolls. No thresholds to tune.",
    "f2.t": "No flicker when switching files",
    "f2.b":
      "The width is event driven, written before paint when you switch tabs. Longest-line results are cached per file in localStorage and hit again when you reopen it.",
    "f3.t": "Line numbers only on the cursor line",
    "f3.b":
      "The gutter lights up only the cursor line, every cursor when there are several. It keeps its width and only changes opacity, so the text does not jump.",
    "f4.t": "Scrollbar and minimap stay put",
    "f4.b":
      "The container that holds the text is only widened, never shifted: its right edge stays at the editor's right edge, so the vertical scrollbar and the overview ruler do not move.",
    "f5.t": "Split editors compute separately",
    "f5.b":
      "Every editor group works from its own width and its own content. The inset is a per-editor option, not a global style.",
    "f6.t": "Turn off what you don't want",
    "f6.b":
      "Centering, line numbers following the cursor and the width animation are independent. Only want the line numbers? Turn fitcode.center off and the rest keeps working.",

    "real.title": "In the real editor",
    "real.lede":
      "Different files opened one after another in the same window: the text width follows the longest line, the tab bar always spans the full width, and the scrollbar and minimap stay where they are.",
    "real.cap": "A 7 s screen recording, theme dark-arui",

    "how.title": "How it works",
    "how.lede":
      "The renderer measures the width; Monaco's layout computation reads the result. There is exactly one channel between them: the editor's own rulers option.",
    "how.figcap":
      "Native layout vs FitCode geometry: the text is inset by the pad on both sides; the minimap and scrollbar do not move.",
    "how.s1t": "The renderer measures",
    "how.s1b":
      "<code>media/inject.js</code> is inlined into <code>workbench.html</code>. For every editor it reads the document and derives the longest line's visual width and the centering inset.",
    "how.s2t": "Carried by rulers",
    "how.s2b":
      "The inset is written into that editor's own <code>rulers</code> option (a transparent, invisible ruler) as a carrier. The renderer cannot reach layout computation — this is the only safe channel out.",
    "how.s3t": "The patch lays it out",
    "how.s3b":
      "Monaco's <code>computeLayout</code> reads the rulers and adds the inset to glyphMargin / line numbers / decorations / contentLeft, subtracts 2×pad from contentWidth; <code>EditorScrollbar._setLayout</code> then widens the text container by the pad.",
    "how.note":
      "All four patches are guarded by uniqueness assertions: a mismatched anchor aborts instead of guessing. The original file is backed up to <code>.fitcode.bak</code> before patching and restored verbatim on disable.",

    "install.title": "Install",
    "install.lede": "Not on the Marketplace yet. Clone it into the extensions folder, run Enable once — all of it reversible.",
    "install.s1t": "Copy it into the extensions folder",
    "install.s2t": "Reload, then run Enable",
    "install.s2b":
      "From the Command Palette (<kbd>Cmd/Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>) run <code>FitCode: Enable</code> and reload when prompted.",
    "install.s3t": "Done",
    "install.s3b":
      "Narrow files are centered, wide files fill the panel. Settings take effect in 1-2 seconds — no need to enable again or reload.",
    "install.copy": "Copy",
    "install.offT": "Disable",
    "install.offB":
      "Run <code>FitCode: Disable</code> and reload: both modified files are restored verbatim from the automatic backup.",
    "install.upT": "Upgrade",
    "install.upB":
      "Drop in the new extension folder and run Enable once — an older patch is restored from the backup first, then every patch is applied again.",
    "install.warnT": 'The first enable may warn that the installation "appears to be corrupt"',
    "agent.title": "Don't feel like doing it by hand? Hand it to an agent",
    "agent.desc":
      "Send the prompt below to an AI that can run commands (Claude Code, Codex, and so on). It clones the repo, puts the extension in place and applies the patch. All you do afterwards is reload the window.",
    "agent.prompt":
      "Install the FitCode VS Code extension for me — it makes the editor's text width follow the content.\n\n1. Clone https://github.com/Feudalman/vscode-fitcode.git into a temp directory\n2. In the repo, run: node test/apply.cjs install (syncs the extension into ~/.vscode/extensions/)\n3. Then run: node test/apply.cjs enable (patches the VS Code install folder)\n4. Run: node test/apply.cjs status and confirm the patch is in place\n5. Finally remind me to reload the VS Code window\n\nNotes:\n- enable modifies workbench.desktop.main.js and workbench.html inside the VS Code install folder; both are backed up first and restored verbatim on disable\n- If you cannot find the VS Code install folder, ask me instead of guessing\n- Do not touch any files outside the extension folder and the VS Code install folder",

    "install.warnB":
      "That is the expected result of VS Code's checksum validation (it does not recognise the modified files). Just dismiss it.",

    "settings.title": "Settings",
    "settings.lede":
      "Takes effect once enabled; changes land in a second or two, with no window reload.",
    "th.key": "Setting",
    "th.default": "Default",
    "th.effect": "Effect",
    "th.off": "With centering off",
    "settings.note":
      "The renderer has no access to the settings API, so the extension writes these into <code>out/vs/workbench/fitcode.config.json</code> (created on enable, deleted on disable); the renderer polls it every 2 seconds and when the window gains focus.",
    "recipe1.t": "Line numbers only",
    "recipe2.t": "Centered, native line numbers",
    "recipe3.t": "Centered, no animation",

    "limits.title": "What it doesn't do",
    "limits.lede": "These boundaries are part of the design, not bugs waiting to be fixed.",
    "lim1": "Files with <code>editor.wordWrap</code> enabled are not centered — centering is meaningless in wrapped mode.",
    "lim2":
      "Editor panels narrower than 400px are not centered — a window shrunk to a small square looks like it does nothing at all.",
    "lim3":
      "A VS Code upgrade can break the patch anchors; the extension detects it and refuses to patch (it never damages the install). Support for the new version has to wait.",
    "lim4":
      "It modifies files inside the install folder: uninstalling the extension does not revert them, so disable it once before removing it.",

    "footer.license": "MIT licensed · maintained by Feudalman",
    "footer.docs": "Readme",
    "footer.docsUrl": "https://github.com/Feudalman/vscode-fitcode/blob/main/README.md",
    "footer.theme": "Colour theme: dark-arui",
  };

  var DYNAMIC = {
    zh: { copy: "复制", copied: "已复制" },
    en: { copy: "Copy", copied: "Copied" },
  };

  var lang = "zh";

  function applyLang(next) {
    lang = next === "en" ? "en" : "zh";
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      if (el.dataset.zhHtml === undefined) el.dataset.zhHtml = el.innerHTML;
      var value = lang === "zh" ? el.dataset.zhHtml : EN[el.dataset.i18n];
      if (value !== undefined) el.innerHTML = value;
    });

    document.querySelectorAll("[data-i18n-href]").forEach(function (el) {
      var key = el.dataset.i18nHref;
      if (el.dataset.zhHref === undefined) el.dataset.zhHref = el.getAttribute("href") || "";
      var value = lang === "zh" ? el.dataset.zhHref : EN[key];
      if (value) el.setAttribute("href", value);
    });

    document.querySelectorAll("[data-i18n-label]").forEach(function (el) {
      var key = el.dataset.i18nLabel;
      if (el.dataset.zhLabel === undefined) el.dataset.zhLabel = el.getAttribute("aria-label") || "";
      var value = lang === "zh" ? el.dataset.zhLabel : EN[key];
      if (value) el.setAttribute("aria-label", value);
    });

    if (lang === "en") {
      document.title = EN["meta.title"];
      var desc = document.querySelector('meta[name="description"]');
      if (desc) desc.setAttribute("content", EN["meta.desc"]);
    }

    var langBtn = document.getElementById("lang");
    if (langBtn) {
      langBtn.textContent = lang === "zh" ? "EN" : "中文";
      langBtn.title = lang === "zh" ? "Switch to English" : "切换到中文";
    }

    renderSettings(lang);

    try {
      localStorage.setItem("fitcode-site-lang", lang);
    } catch (e) {
      /* 隐私模式下忽略 */
    }
  }

  var langBtn = document.getElementById("lang");
  if (langBtn) {
    langBtn.addEventListener("click", function () {
      applyLang(lang === "zh" ? "en" : "zh");
    });
  }

  var saved = null;
  try {
    saved = localStorage.getItem("fitcode-site-lang");
  } catch (e) {
    /* ignore */
  }
  var detected = (navigator.language || "en").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  applyLang(saved === "zh" || saved === "en" ? saved : detected);

  /* ---------------------------------------------------------------
     4. 复制安装命令
     --------------------------------------------------------------- */

  document.querySelectorAll(".copy").forEach(function (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var scope = copyBtn.closest(".code") || copyBtn.parentElement;
      var code = scope.querySelector("code");
      var text = code ? code.textContent : "";
      var done = function () {
        copyBtn.textContent = DYNAMIC[lang].copied;
        setTimeout(function () {
          copyBtn.textContent = DYNAMIC[lang].copy;
        }, 1600);
      };
      var fallback = function () {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        document.body.appendChild(area);
        area.select();
        try {
          document.execCommand("copy");
        } catch (e) {
          /* 失败也要给反馈，用户至少能手动选中 */
        }
        document.body.removeChild(area);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          fallback();
          done();
        });
      } else {
        fallback();
        done();
      }
    });
  });
})();
