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
