# Changelog

All notable changes to the FitCode extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-11-09

### Changed

- The extension id is now `arui.fit-code` (was `arui.fitcode`) and the
  repository moved to `Feudalman/vscode-fit-code`. Command ids and setting
  keys are unchanged (`fitcode.*`), so existing settings keep working — but
  the old id has to be uninstalled and the new one installed once.

### Added

- Word-wrapped files (markdown by default) are handled instead of being skipped.
  Centering still depends only on how wide the content is: too wide fills the
  panel and folds at the panel width (no horizontal scrolling), narrow enough is
  centered with the fold width shrinking along with the inset. For that the
  layout patch recomputes `viewportColumn` / `wrappingColumn` from the narrowed
  width — without it the inset only moved the text and the lines kept wrapping
  at the full panel width.
- `wordWrap: "wordWrapColumn"` (a column width you fixed yourself) still opts out.

## [0.1.1] - 2026-11-09

Documentation only — the extension code is identical to 0.1.0.

### Changed

- Install instructions now point at the Marketplace (`arui.fit-code`) instead of
  asking you to copy the repo into `~/.vscode/extensions/`. Same for upgrading:
  update the extension, then run `FitCode: Enable` once.
- The website's install section leads with the Marketplace button and the
  command line equivalent, and notes that a source copy must not be installed
  side by side with the Marketplace build (both would patch the install folder).
- The bundled agent prompt installs from the Marketplace first and only falls
  back to cloning the repo.

## [0.1.0] - 2026-11-06

First public release.

### Added

- Adaptive text width: the editor text is centered when the content fits and
  fills the panel (with horizontal scrolling) when it does not. No thresholds
  to configure, per editor, recomputed when the file changes.
- Line numbers indent together with the text; the scrollbar and the minimap stay
  pinned to the editor's right edge. Split editors are computed independently.
- Line numbers can be limited to the cursor lines (`fitcode.lineNumbersOnlyAtCursor`),
  with the line number column width preserved so the text does not jump.
- Optional width animation (`fitcode.animate`, `fitcode.animateDuration`), 140 ms
  by default.
- Per-file width cache in `localStorage`, keyed by a fingerprint of the document.
- Every feature can be turned off on its own through VS Code settings.
- English and Simplified Chinese UI.

### Notes

- FitCode works by patching `workbench.desktop.main.js` and `workbench.html` in
  the VS Code install folder. Both files are backed up automatically and restored
  by `FitCode: Disable`. VS Code updates replace the whole folder, which removes
  the patch; the extension detects that and notifies you.
- After enabling, VS Code may report "Your Code installation appears corrupt" —
  that is the expected hash check reaction, safe to dismiss.
