/*
    SPDX-FileCopyrightText: 2018 Eon S. Jeon <esjeon@hyunmu.am>
    SPDX-FileCopyrightText: 2024 Vjatcheslav V. Kolchkov <akl334@protonmail.ch>

    SPDX-License-Identifier: MIT
*/

function toQRect(rect: Rect) {
  return Qt.rect(rect.x, rect.y, rect.width, rect.height);
}

function toRect(qrect: QRect) {
  return new Rect(qrect.x, qrect.y, qrect.width, qrect.height);
}

/* KWin destroys Output QObjects on monitor hotplug, resume from sleep, and
 * output reconfiguration. Reading a property of a dangling wrapper returns
 * undefined or throws depending on the Qt version, and passing one back
 * into KWin API calls (e.g. workspace.clientArea) can crash KWin itself --
 * so treat both failure modes as "dead" and never touch a dead output. */
function outputIsAlive(output: Output | null | undefined): boolean {
  try {
    return !!output && typeof output.name === "string";
  } catch (e) {
    return false;
  }
}

/* Find the live Output with the given name, or null if it's not connected.
 * Outputs keep their name across unplug/replug cycles even though the
 * underlying QObject is recreated, so the name is the stable identity. */
function findOutputByName(workspace: Workspace, name: string): Output | null {
  for (const output of workspace.screens) {
    if (outputIsAlive(output) && output.name === name) return output;
  }
  return null;
}

/* The window's output resolved to the current screen, else the active
 * screen. A window can be null, already deleted, or -- during a
 * hotplug/resume flurry -- still point at a destroyed Output wrapper before
 * KWin reassigns it. Handing any of those to KWin APIs (workspace.clientArea
 * etc.) can crash KWin, so fall back to a known-live output instead.
 *
 * Even when the window's own wrapper is readable it is resolved by name
 * against workspace.screens rather than returned directly: a disabled/
 * re-created output leaves the window pointing at a stale wrapper whose
 * name still reads but which is a different object than the one surfaces
 * are rebuilt from, so comparing it in visible() would drop the window and
 * commit() would pass a stale output to clientArea(). When the name is no
 * longer a current screen (output truly gone), fall back to activeScreen. */
function resolveWindowOutput(
  workspace: Workspace,
  window: Window | null | undefined,
): Output {
  if (window && !window.deleted && outputIsAlive(window.output)) {
    const live = findOutputByName(workspace, window.output.name);
    if (live !== null) return live;
  }
  return workspace.activeScreen;
}
