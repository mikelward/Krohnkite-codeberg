/*
    SPDX-FileCopyrightText: 2018 Eon S. Jeon <esjeon@hyunmu.am>
    SPDX-FileCopyrightText: 2024 Vjatcheslav V. Kolchkov <akl334@protonmail.ch>

    SPDX-License-Identifier: MIT
*/

/**
 * Abstracts KDE implementation specific details.
 *
 * Driver is responsible for initializing the tiling logic, connecting
 * signals(Qt/KDE term for binding events), and providing specific utility
 * functions.
 */
var KWIN: KWin;

class KWinDriver implements IDriverContext {
  public static backendName: string = "kwin";

  public get backend(): string {
    return KWinDriver.backendName;
  }

  public get currentSurface(): ISurface {
    return this._surfaceStore.getSurface(
      this.workspace.activeWindow
        ? this.workspace.activeWindow.output
        : this.workspace.activeScreen,
      this.workspace.currentActivity,
      this.workspace.currentDesktop,
    );
  }

  public set currentSurface(value: ISurface) {
    const ksrf = value as KWinSurface;

    /* NOTE: only supports switching desktops */
    // TODO: fousing window on other screen?
    // TODO: find a way to change activity

    if (this.workspace.currentDesktop.id !== ksrf.vDesktop.id)
      this.workspace.currentDesktop = ksrf.vDesktop;
    if (this.workspace.currentActivity !== ksrf.activity)
      this.workspace.currentActivity = ksrf.activity;
  }

  public get currentWindow(): WindowClass | null {
    const client = this.workspace.activeWindow;
    return client ? this.windowMap.get(client) : null;
  }

  public set currentWindow(window: WindowClass | null) {
    if (window !== null) {
      window.timestamp = getTime();
      this.workspace.activeWindow = (window.window as KWinWindow).window;
    }
  }

  public get currentSurfaces(): ISurface[] {
    const currentSurfaces: ISurface[] = [];
    this.workspace.screens.forEach((output) => {
      // Each output can show a different virtual desktop (per-screen virtual
      // desktops), so resolve the desktop per output rather than using the
      // global currentDesktop — otherwise every non-active output gets tiled
      // against the wrong desktop (e.g. the source output isn't re-tiled after
      // a window moves away). Falls back to the global desktop on pre-6.7 KWin.
      currentSurfaces.push(
        this._surfaceStore.getSurface(
          output,
          this.workspace.currentActivity,
          this._outputCurrentDesktop(output),
        ),
      );
    });
    return currentSurfaces;
  }

  public get cursorPosition(): [number, number] | null {
    const workspacePos = this.workspace.cursorPos;
    return workspacePos !== null ? [workspacePos.x, workspacePos.y] : null;
  }

  public get isMetaMode(): boolean {
    return this._isMetaMode.state;
  }

  public workspace: Workspace;
  private shortcuts: IShortcuts;
  private engine: TilingEngine;
  private control: TilingController;
  private windowMap: WrapperMap<Window, WindowClass>;
  private entered: boolean;
  private _surfaceStore: KWinSurfaceStore;
  private _isMetaMode: IKrohnkiteMeta;

  constructor(api: Api) {
    KWIN = api.kwin;
    CONFIG = KWINCONFIG = new KWinConfig();
    DBUS = new DBusManager(api.dbus);
    this.workspace = api.workspace;
    this.shortcuts = api.shortcuts;
    this.engine = new TilingEngine();
    this.control = new TilingController(this.engine);
    this.windowMap = new WrapperMap(
      (client: Window) => KWinWindow.generateID(client),
      (client: Window) =>
        new WindowClass(
          new KWinWindow(client, this.workspace, this._surfaceStore),
        ),
    );
    this.entered = false;
    this._surfaceStore = new KWinSurfaceStore(this.workspace);
    this._isMetaMode = {
      state: false,
      lastPushed: 0,
      toggleMode: CONFIG.metaIsToggle,
    };
  }

  /*
   * Main
   */

  public main() {
    LOG?.send(LogModules.printConfig, undefined, `Config: ${CONFIG}`);
    this.bindEvents();
    this.bindShortcut();

    const clients: Window[] = this.workspace.stackingOrder;
    for (let i = 0; i < clients.length; i++) {
      this.addWindow(clients[i]);
    }
  }

  private addWindow(client: Window): WindowClass | null {
    if (client.dock) {
      // Docks reserve screen space but aren't tiled. Handle that reservation
      // separately and skip the normal window management path.
      this.manageDock(client);
      return null;
    }
    if (this.windowMap.has(client)) return null;
    if (
      !client.deleted &&
      client.pid >= 0 &&
      !client.popupWindow &&
      client.normalWindow &&
      !client.hidden &&
      client.width * client.height > 10
    ) {
      const window = this.windowMap.add(client);
      if (client.maximizeMode > 0) {
        (window.window as KWinWindow).maximized = true;
        // it can set maximized to false when window start already with maximized flag
        // client.setMaximize(false, false);
      }
      this.control.onWindowAdded(this, window);
      if (window.state !== WindowState.Unmanaged) {
        this.bindWindowEvents(window, client);
        LOG?.send(LogModules.newWindowAdded, "", debugWin(client), {
          winClass: [`${client.resourceClass}`],
        });
        return window;
      } else {
        this.windowMap.remove(client);
        LOG?.send(LogModules.newWindowUnmanaged, "", debugWin(client), {
          winClass: [`${client.resourceClass}`],
        });
      }
    } else {
      LOG?.send(LogModules.newWindowFiltered, "", debugWin(client), {
        winClass: [`${client.resourceClass}`],
      });
    }
    return null;
  }

  private manageDock(client: Window): void {
    const placementArea = () =>
      toRect(
        this.workspace.clientArea(
          ClientAreaOption.PlacementArea,
          client.output,
          this.workspace.currentDesktop,
        ),
      );
    let prevPlacement = {
      desktop: this.workspace.currentDesktop,
      area: placementArea(),
    };
    // Re-tile now to account for a dock whose area reservation already exists.
    this.control.onSurfaceUpdate(this);
    // Subscribe to future area changes of each dock to make sure tiled
    // windows aren't overlapped by the dock or have an excessive gap.
    this.connect(client.frameGeometryChanged, () => {
      if (!client || client.deleted) {
        return;
      }
      const desktop = this.workspace.currentDesktop;
      const area = placementArea();
      if (
        desktop.id === prevPlacement.desktop.id &&
        area.equals(prevPlacement.area)
      ) {
        // NOP if the area didn't actually change. This prevents auto-hiding
        // docks from causing re-tiles.
        return;
      }
      prevPlacement = { desktop, area };
      this.control.onSurfaceUpdate(this);
    });
  }

  public focusNeighborWindow(
    direction: Direction,
    winTypes: WinTypes,
  ): Window | null | boolean {
    let window = this.workspace.activeWindow;
    if (!window) return null;
    let windows = this._getWindowsByDirection(
      winTypes,
      this.currentSurface,
      toRect(window.frameGeometry),
      direction,
    );
    if (windows.length === 0) return null;
    let idx = windows.indexOf(window);
    if (idx < 0) {
      this.workspace.activeWindow = windows[0];
      return true;
    }
    if (windows.length === 1) return window;

    if (
      this._setFocusOnSurface(
        window,
        this.currentSurface,
        direction,
        winTypes,
        windows,
      )
    )
      return true;

    return window;
  }

  public focusOutput(
    window: Window | null,
    direction: Direction,
    winTypes: WinTypes,
  ): boolean {
    let neighbor = KWinDriver.getNeighborOutput(
      this.workspace,
      direction,
      this.workspace.activeScreen,
    );
    if (neighbor === null) return false;
    // Make the neighbor output active, then resolve its surface against the
    // desktop that output is actually showing (per-screen virtual desktops).
    // Activating focuses the desktop, which also serves as the fallback when the
    // neighbor has no window to focus.
    this._makeActiveScreen(neighbor, false);
    let neighbor_surface = this._surfaceStore.getSurface(
      neighbor,
      this.workspace.currentActivity,
      this._outputCurrentDesktop(neighbor),
    );
    if (
      !this._setFocusOnSurface(window, neighbor_surface, direction, winTypes)
    ) {
      // Neighbor screen has no focusable window; we already switched to its
      // desktop, so just announce the screen change like before.
      this.showNotification("Active screen");
    }
    return true;
  }

  public focusSpecial(direction: Direction): boolean {
    switch (direction) {
      case "up": {
        let screens = this.workspace.screens;
        if (screens.length === 1) return true;
        let output = this.workspace.activeScreen;
        let idx = screens.indexOf(output);
        if (idx < 0) {
          warning(`kwindriver: focusNeighborWindow: screen doesn't found.`);
          return false;
        }
        idx = idx < screens.length - 1 ? idx + 1 : 0;
        this._makeActiveScreen(screens[idx]);
        if (CONFIG.movePointerOnFocus) {
          DBUS.moveMouseToCenter();
        }
        return false;
      }
      case "down": {
        let window = this.workspace.activeWindow;
        if (!window) return false;
        let windows = this._getWindowsByDirection(
          WinTypes.special,
          this.currentSurface,
          toRect(window.frameGeometry),
          direction,
        );
        let idx = windows.indexOf(window);
        if (idx < 0) {
          this.workspace.activeWindow = windows[0];
          if (CONFIG.movePointerOnFocus) {
            DBUS.moveMouseToFocus();
          }
          return false;
        }
        if (windows.length === 1) return false;
        idx = idx < windows.length - 1 ? idx + 1 : 0;
        this.workspace.activeWindow = windows[idx];
        if (CONFIG.movePointerOnFocus) {
          DBUS.moveMouseToFocus();
        }
        return false;
      }
      case "right":
      case "left": {
        let desktops = this.workspace.desktops;
        if (desktops.length === 1) return true;
        let currentDesktop = this.workspace.currentDesktop;
        let idx = desktops.indexOf(currentDesktop);
        if (idx < 0) {
          warning(`kwindriver: focusNeighborWindow: vDesktop doesn't found.`);
          return false;
        }
        if (direction === "left") {
          idx = idx > 0 ? idx - 1 : desktops.length - 1;
        } else {
          idx = idx < desktops.length - 1 ? idx + 1 : 0;
        }
        this.workspace.currentDesktop = desktops[idx];
        return true;
      }
    }
  }

  public focusVDesktop(
    window: Window | null,
    direction: Direction,
    winTypes: WinTypes,
  ): boolean {
    let neighbor = this._getNeighborVirtualDesktop(direction);
    if (neighbor === null) return false;
    // Keep the same monitor when change virtual desktop.
    // TODO: delete next two strings
    // let output = this._getOutputByDirection(direction);
    // let targetOutput = output !== null ? output : this.workspace.activeScreen;
    let targetOutput = this.workspace.activeScreen;
    // Switch THIS output to the neighbor desktop via the per-output API. Setting
    // the global workspace.currentDesktop instead would jump focus to whichever
    // output already shows that desktop (per-screen virtual desktops).
    this._setOutputDesktop(targetOutput, neighbor);
    // Make the intended output active after the switch so focus lands there.
    this._makeActiveScreen(targetOutput, false);
    let neighbor_surface = this._surfaceStore.getSurface(
      targetOutput,
      this.workspace.currentActivity,
      neighbor,
    );
    let result = this._setFocusOnSurface(
      window,
      neighbor_surface,
      direction,
      winTypes,
    );
    if (CONFIG.movePointerOnFocus) {
      DBUS.moveMouseToCenter();
    }
    return result;
  }

  public static getNeighborOutput(
    workspace: Workspace,
    direction: Direction,
    source: Output,
  ): Output | null {
    let retOutput = null;
    let intersection = 0;
    let sourceRect = toRect(source.geometry);
    function isOutputCandidate(
      targetRect: Rect,
      coordinate: "x" | "y",
    ): boolean {
      let currentIntersection = sourceRect.intersection(targetRect, coordinate);
      if (currentIntersection > intersection) {
        intersection = currentIntersection;
        return true;
      }
      return false;
    }
    for (let target of workspace.screens) {
      if (target === source) continue;
      let targetRect = toRect(target.geometry);
      switch (direction) {
        case "left": {
          if (sourceRect.x === targetRect.maxX) {
            if (isOutputCandidate(targetRect, "y")) retOutput = target;
          }
          break;
        }
        case "right": {
          if (sourceRect.maxX === targetRect.x) {
            if (isOutputCandidate(targetRect, "y")) retOutput = target;
          }
          break;
        }
        case "up": {
          if (sourceRect.y === targetRect.maxY) {
            if (isOutputCandidate(targetRect, "x")) retOutput = target;
          }
          break;
        }
        case "down": {
          if (sourceRect.maxY === targetRect.y) {
            if (isOutputCandidate(targetRect, "x")) retOutput = target;
          }
          break;
        }
        default: {
          break;
        }
      }
    }
    return retOutput;
  }

  public setTimeout(func: () => void, timeout: number) {
    KWinSetTimeout(() => this.enter(func), timeout);
  }

  public showNotification(text: string) {
    if (CONFIG.notificationDuration > 0)
      popupDialog.showNotification(text, CONFIG.notificationDuration);
  }

  public metaPushed() {
    if (CONFIG.metaIsToggle) {
      this._isMetaMode.state = !this._isMetaMode.state;
      this.showNotification(
        `Meta toggled ${this._isMetaMode.state ? "on" : "off"}`,
      );
    } else if (CONFIG.metaIsPushedTwice) {
      let pushedTime = getTime();
      if (pushedTime - this._isMetaMode.lastPushed < CONFIG.metaTimeout - 200) {
        this._isMetaMode.toggleMode = !this._isMetaMode.toggleMode;
        this._isMetaMode.state = this._isMetaMode.toggleMode;
        this.showNotification(
          `Meta toggled ${this._isMetaMode.state ? "on" : "off"}`,
        );
      } else {
        if (!this._isMetaMode.state) {
          this._isMetaMode.state = true;
          this.showNotification(`Meta on`);
          this.setTimeout(() => {
            if (!this._isMetaMode.toggleMode) {
              this._isMetaMode.state = false;
            }
          }, CONFIG.metaTimeout);
        }
      }
      this._isMetaMode.lastPushed = pushedTime;
    } else {
      if (!this._isMetaMode.state) {
        this._isMetaMode.state = true;
        this.showNotification(`Meta on`);
        this.setTimeout(() => {
          this._isMetaMode.state = false;
        }, CONFIG.notificationDuration);
      }
    }
  }

  public moveWindowsToScreen(
    windowsToScreen: [output: Output, windows: WindowClass[]][],
  ): void {
    const clients: KWinWindow["window"][] = [];

    for (const [output, windows] of windowsToScreen) {
      for (const window of windows) {
        const client = (window.window as KWinWindow).window;
        try {
          this.workspace.sendClientToScreen(client, output);
        } catch (e) {
          // continue on error
        }
        clients.push(client);
      }
    }

    if (clients.length === 0) return;

    const lastClient = clients[clients.length - 1];
    const interval = 20;
    const maxWait = 100;
    let elapsed = 0;

    const verifyClientOnOutput = (): boolean => {
      try {
        const out = lastClient.output;
        if (out) return true;

        return false;
      } catch (e) {
        return false;
      }
    };

    const finishActivation = () => {
      try {
        this.workspace.activeWindow = lastClient;
      } catch (e) {
        // ignore
      }

      try {
        this.control.engine.arrange(this, "moveWindowsToScreen");
      } catch (e) {
        // ignore
      }
    };

    const poll = () => {
      if (verifyClientOnOutput()) {
        finishActivation();
        return;
      }

      elapsed += interval;
      if (elapsed >= maxWait) {
        finishActivation();
        return;
      }

      this.setTimeout(poll, interval);
    };

    // Start polling after issuing the sends
    this.setTimeout(poll, interval);
  }

  public moveToScreen(
    window: WindowClass,
    direction: Direction,
    targetOutput: Output | null = null,
    retargetDesktop: boolean = true,
  ): boolean {
    const client = (window.window as KWinWindow).window;

    // Try the client's output property and match by name
    let sourceOutput: Output | null = null;
    const clientOut = client.output;
    if (clientOut) {
      for (const out of this.workspace.screens) {
        try {
          if (out.name && clientOut.name && out.name === clientOut.name) {
            sourceOutput = out;
            break;
          }
        } catch (e) {
          /* ignore per-output errors */
        }
      }
    }

    // If we don't have a source, give up.
    if (!sourceOutput) return false;

    // Find the adjacent output.
    if (!targetOutput) {
      try {
        targetOutput = KWinDriver.getNeighborOutput(
          this.workspace,
          direction,
          sourceOutput,
        );
      } catch (e) {
        targetOutput = null;
      }
    }

    if (!targetOutput) return false;

    // Per-screen virtual desktops: the target output may show a different
    // desktop than the window's. We must move the window VISIBLE-then-fix:
    // sendClientToScreen won't move a hidden window (one whose desktop isn't
    // shown on its current output), so we send first while the window is still
    // visible on the source, then once it has landed on the target output we
    // reassign it to that output's visible desktop. Setting the desktop first
    // would hide the window on the source and the send would no-op.
    let retargetTo: VirtualDesktop | null =
      retargetDesktop && !client.onAllDesktops
        ? this._outputCurrentDesktop(targetOutput)
        : null;
    // When the target output shows a different desktop, sendClientToScreen
    // hides the window (it reassigns its desktop to the target's) and then
    // can't move a hidden window — the output change races the hide and only
    // sometimes wins. Bridge via on-all-desktops: a window visible everywhere is
    // never hidden mid-move, so the output change always lands. We restore the
    // proper desktop once it has arrived.
    const bridge =
      retargetTo !== null &&
      !(
        client.desktops.length === 1 && client.desktops[0].id === retargetTo.id
      );
    if (bridge) {
      try {
        client.desktops = [];
      } catch (e) {
        /* ignore */
      }
    }

    try {
      this.workspace.sendClientToScreen(client, targetOutput);
    } catch (e) {
      return false;
    }

    // Poll until timeout — then finish activation.
    const interval = 20;
    const maxWait = 100;
    let elapsed = 0;

    const finishActivation = () => {
      // Once on the target output, drop the on-all-desktops bridge and pin the
      // window to that output's visible desktop. If the move never landed, leave
      // it on-all-desktops (visible) rather than pinning it to a desktop the
      // source output isn't showing, which would make it vanish.
      if (bridge && retargetTo !== null && client.output === targetOutput) {
        try {
          client.desktops = [retargetTo];
        } catch (e) {
          /* ignore */
        }
      }
      try {
        this.workspace.activeWindow = client;
        if (CONFIG.movePointerOnFocus) {
          DBUS.moveMouseToCenter(20);
        }
      } catch (e) {
        /* ignore */
      }

      try {
        this.control.engine.arrange(this, "moveToScreen");
      } catch (e) {
        /* ignore */
      }
    };

    const poll = () => {
      if (client.output === targetOutput) {
        finishActivation();
        return;
      }
      elapsed += interval;
      if (elapsed >= maxWait) {
        finishActivation();
        return;
      }

      this.setTimeout(poll, interval);
    };

    // Start polling after a short initial delay
    this.setTimeout(poll, interval);
    return true;
  }

  public moveToVDesktop(window: WindowClass, direction: Direction): boolean {
    let targetVDesktop = this._getNeighborVirtualDesktop(direction);
    if (targetVDesktop === null) return false;
    let client = (window.window as KWinWindow).window;
    this.workspace.currentDesktop = targetVDesktop;
    client.desktops = [targetVDesktop];
    this.workspace.activeWindow = client;
    //TODO: delete next 5 commented string. This code given ability to move window on different monitor during move to neighbor VDesktop.
    //   let output = this._getOutputByDirection(direction);
    //   if (output !== null) {
    //     this.moveToScreen(window, direction, output, false);
    //     return false; // moveWindowsToScreen arrange screens
    //   }
    return true;
  }

  private _getOutputByDirection(direction: Direction): Output | null {
    let oppositeDirection = getOppositeDirection(direction);
    let currentOutput = this.workspace.activeScreen;
    let sourceOutput = currentOutput;
    let targetOutput: Output | null;

    while (
      (targetOutput = KWinDriver.getNeighborOutput(
        this.workspace,
        oppositeDirection,
        sourceOutput,
      )) !== null
    ) {
      sourceOutput = targetOutput;
    }
    return sourceOutput !== currentOutput ? sourceOutput : null;
  }

  private _setFocusOnSurface(
    window: Window | null,
    surface: ISurface,
    direction: Direction,
    winTypes: WinTypes,
    localWindows: Window[] | null = null,
  ): boolean {
    let sourceRect: Rect;
    if (localWindows !== null && window !== null) {
      sourceRect = toRect(window.frameGeometry);
    } else if (window !== null) {
      let tG = toRect(surface.output.geometry);
      let sG = window.output.geometry;
      let winRect = toRect(window.frameGeometry);

      switch (direction) {
        case "left": {
          let y_ratio = (winRect.y - sG.y) / sG.height;
          let y = tG.y + tG.height * y_ratio;
          sourceRect = new Rect(
            tG.maxX - 5,
            y,
            5,
            y + winRect.height < tG.y + tG.height
              ? winRect.height
              : tG.height - (y - tG.y),
          );
          break;
        }
        case "right": {
          let y_ratio = (winRect.y - sG.y) / sG.height;
          let y = tG.y + tG.height * y_ratio;
          sourceRect = new Rect(
            tG.x,
            y,
            5,
            y + winRect.height < tG.y + tG.height
              ? winRect.height
              : tG.height - (y - tG.y),
          );
          break;
        }
        case "up": {
          let x_ratio = (winRect.x - sG.x) / sG.width;
          let x = tG.x + tG.width * x_ratio;
          sourceRect = new Rect(
            x,
            tG.maxY - 5,
            x + winRect.width < tG.x + tG.width
              ? winRect.width
              : tG.width - (x - tG.x),
            5,
          );
          break;
        }
        case "down": {
          let x_ratio = (winRect.x - sG.x) / sG.width;
          let x = tG.x + tG.width * x_ratio;
          sourceRect = new Rect(
            x,
            tG.y,
            x + winRect.width < tG.x + tG.width
              ? winRect.width
              : tG.width - (x - tG.x),
            5,
          );
          break;
        }
      }
    } else {
      let nG = toRect(surface.output.geometry);
      switch (direction) {
        case "left": {
          sourceRect = new Rect(nG.maxX - 5, nG.y, 5, nG.height);
          break;
        }
        case "right": {
          sourceRect = new Rect(nG.x, nG.y, 5, nG.height);
          break;
        }
        case "up": {
          sourceRect = new Rect(nG.x, nG.maxY - 5, nG.width, 5);
          break;
        }
        case "down": {
          sourceRect = new Rect(nG.x, nG.y, nG.width, 5);
          break;
        }
      }
    }
    let windows: Window[];
    if (localWindows !== null) {
      windows = localWindows;
    } else {
      windows = this._getWindowsByDirection(
        winTypes,
        surface,
        sourceRect,
        direction,
      );
    }
    let focusCandidate: Window | null = null;
    let fCTimeStamp: number | null | undefined = null;
    let distance = null;
    let d;
    for (let win of windows) {
      if (window !== null && win === window) continue;
      let winRect = toRect(win.bufferGeometry);
      d =
        sourceRect.distance(winRect) +
        sourceRect.overallDimension(winRect, direction);
      if (focusCandidate === null || distance === null || d < distance) {
        distance = d;
        focusCandidate = win;
      } else if (focusCandidate !== null && d === distance) {
        if (fCTimeStamp === null) {
          fCTimeStamp = this.engine.windows.getWindowById(
            String(focusCandidate.internalId),
          )?.timestamp;
        }
        let timestamp = this.engine.windows.getWindowById(
          String(win.internalId),
        )?.timestamp;
        if (
          (timestamp && fCTimeStamp && timestamp < fCTimeStamp) ||
          (timestamp && !fCTimeStamp)
        ) {
          fCTimeStamp = timestamp;
          focusCandidate = win;
        }
      }
    }
    if (focusCandidate !== null) {
      this.workspace.activeWindow = focusCandidate;
      return true;
    } else {
      return false;
    }
  }

  private _getWindowsByDirection(
    wType: WinTypes,
    surface: ISurface,
    rect: Rect,
    direction: Direction,
    window?: Window,
  ): Window[] {
    let windows: Window[] = [];
    function mapWinClassToKWinWindow(winClassWindows: WindowClass[]): Window[] {
      return winClassWindows.map(
        (winClassWin) => (winClassWin.window as KWinWindow).window,
      );
    }
    switch (wType) {
      case WinTypes.tiled | WinTypes.docked | WinTypes.float: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleWindows(surface),
        );
        break;
      }
      case WinTypes.surfaces: {
        windows = [];
        break;
      }
      case WinTypes.tiled: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleTiles(surface),
        );
        break;
      }
      case WinTypes.float: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleFloat(surface),
        );
        break;
      }
      case WinTypes.docked: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleDocked(surface),
        );
        break;
      }
      case WinTypes.tiled | WinTypes.float: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleTilesOrFloat(surface),
        );
        break;
      }
      case WinTypes.tiled | WinTypes.docked: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleTilesOrDocked(surface),
        );
        break;
      }
      case WinTypes.float | WinTypes.docked: {
        windows = mapWinClassToKWinWindow(
          this.engine.windows.getVisibleFloatOrDocked(surface),
        );
        break;
      }
      case WinTypes.special: {
        windows = this.workspace.stackingOrder.filter(
          (win) =>
            win.output === surface.output &&
            (win.desktops.length === 0 ||
              win.desktops.indexOf(surface.vDesktop) > -1) &&
            !win.minimized &&
            !win.hidden &&
            !win.deleted &&
            win.resourceClass !== "plasmashell",
        );
        return windows;
      }
    }
    let filterFunc: (r: Rect) => boolean;
    switch (direction) {
      case "left":
        filterFunc = (r) => {
          return rect.x >= r.x && rect.intersection(r, "y") > 0;
        };
        break;
      case "right":
        filterFunc = (r) => {
          return rect.x <= r.x && rect.intersection(r, "y") > 0;
        };
        break;
      case "up":
        filterFunc = (r) => {
          return rect.y >= r.y && rect.intersection(r, "x") > 0;
        };
        break;
      case "down":
        filterFunc = (r) => {
          return rect.y <= r.y && rect.intersection(r, "x") > 0;
        };
        break;
    }
    windows = windows.filter((win) => {
      if (window && window === win) return false;
      let r = toRect(win.frameGeometry);
      return filterFunc(r);
    });
    return windows;
  }

  private _getNeighborVirtualDesktop(
    direction: Direction,
  ): VirtualDesktop | null {
    const currentVDesktop = this.workspace.currentDesktop;
    const vDesktops = this.workspace.desktops;
    const netSize = this.workspace.desktopGridSize;

    if (!currentVDesktop) return null;

    const total = vDesktops.length;
    const width = netSize.width;
    const height = netSize.height;

    // Find index of current desktop (0-based)
    const idx = vDesktops.indexOf(currentVDesktop);
    if (idx < 0) return null;

    // If width or height is 1, that axis has no neighbors.
    if ((direction === "left" || direction === "right") && width === 1)
      return null;
    if ((direction === "up" || direction === "down") && height === 1)
      return null;

    if (direction === "left" || direction === "right") {
      // column: 1..width
      const col = (idx % width) + 1;
      if (direction === "left") {
        // already at leftmost column?
        if (col === 1) return null;
        // neighbor is previous desktop in array
        return vDesktops[idx - 1] ?? null;
      } else {
        // right
        if (col === width) return null;
        // neighbor is next desktop in array (ensure within total)
        return idx + 1 < total ? vDesktops[idx + 1] : null;
      }
    } else {
      // up / down: compute row (1..height)
      const row = Math.ceil((idx + 1) / width);
      if (direction === "up") {
        if (row === 1) return null;
        const neighborIdx = idx - width;
        return neighborIdx >= 0 ? vDesktops[neighborIdx] : null;
      } else {
        // down
        if (row === height) return null;
        const neighborIdx = idx + width;
        return neighborIdx < total ? vDesktops[neighborIdx] : null;
      }
    }
  }

  // Read the virtual desktop currently shown on a specific output. Uses KWin
  // 6.7's per-output API (workspace.currentDesktopForScreen) and falls back to
  // the global currentDesktop on older KWin, where every output shares it.
  private _outputCurrentDesktop(output: Output): VirtualDesktop {
    if (typeof this.workspace.currentDesktopForScreen === "function") {
      try {
        const d = this.workspace.currentDesktopForScreen(output);
        if (d) return d;
      } catch (e) {
        /* fall through to the global desktop */
      }
    }
    return this.workspace.currentDesktop;
  }

  // Switch a specific output to a virtual desktop via KWin 6.7's per-output API.
  // Signature per KWin's src/scripting/workspace_wrapper.cpp:
  //   setCurrentDesktopForScreen(VirtualDesktop *desktop, LogicalOutput *output)
  // Falls back to the global currentDesktop setter on older KWin (which on a
  // per-screen setup would jump to the output already showing the desktop, but
  // older KWin has no per-screen desktops so the global setter is correct there).
  private _setOutputDesktop(output: Output, desktop: VirtualDesktop): void {
    if (typeof this.workspace.setCurrentDesktopForScreen === "function") {
      try {
        this.workspace.setCurrentDesktopForScreen(desktop, output);
        return;
      } catch (e) {
        /* fall through to the global setter */
      }
    }
    this.workspace.currentDesktop = desktop;
  }

  private _makeActiveScreen(output: Output, notify: boolean = true) {
    for (let win of this.workspace.stackingOrder) {
      if (win.resourceClass === "plasmashell" && win.output === output) {
        this.workspace.activeWindow = win;
        if (notify) this.showNotification("Active screen");
        break;
      }
    }
  }

  private bindShortcut() {
    const callbackShortcut = (shortcut: Shortcut) => {
      return () => {
        LOG?.send(LogModules.shortcut, `Shortcut pressed:`, `${shortcut}`);
        this.enter(() => this.control.onShortcut(this, shortcut));
      };
    };
    this.shortcuts
      .getToggleDock()
      .activated.connect(callbackShortcut(Shortcut.ToggleDock));
    this.shortcuts
      .getFocusNext()
      .activated.connect(callbackShortcut(Shortcut.FocusNext));
    this.shortcuts
      .getFocusPrev()
      .activated.connect(callbackShortcut(Shortcut.FocusPrev));
    this.shortcuts
      .getFocusDown()
      .activated.connect(callbackShortcut(Shortcut.FocusDown));
    this.shortcuts
      .getFocusUp()
      .activated.connect(callbackShortcut(Shortcut.FocusUp));
    this.shortcuts
      .getFocusLeft()
      .activated.connect(callbackShortcut(Shortcut.FocusLeft));
    this.shortcuts
      .getFocusRight()
      .activated.connect(callbackShortcut(Shortcut.FocusRight));

    this.shortcuts
      .getShiftDown()
      .activated.connect(callbackShortcut(Shortcut.ShiftDown));
    this.shortcuts
      .getShiftUp()
      .activated.connect(callbackShortcut(Shortcut.ShiftUp));
    this.shortcuts
      .getShiftLeft()
      .activated.connect(callbackShortcut(Shortcut.ShiftLeft));
    this.shortcuts
      .getShiftRight()
      .activated.connect(callbackShortcut(Shortcut.ShiftRight));

    this.shortcuts
      .getGrowHeight()
      .activated.connect(callbackShortcut(Shortcut.GrowHeight));
    this.shortcuts
      .getShrinkHeight()
      .activated.connect(callbackShortcut(Shortcut.ShrinkHeight));
    this.shortcuts
      .getShrinkWidth()
      .activated.connect(callbackShortcut(Shortcut.ShrinkWidth));
    this.shortcuts
      .getGrowWidth()
      .activated.connect(callbackShortcut(Shortcut.GrowWidth));

    this.shortcuts
      .getIncrease()
      .activated.connect(callbackShortcut(Shortcut.Increase));
    this.shortcuts
      .getDecrease()
      .activated.connect(callbackShortcut(Shortcut.Decrease));

    this.shortcuts
      .getToggleFloat()
      .activated.connect(callbackShortcut(Shortcut.ToggleFloat));
    this.shortcuts
      .getFloatAll()
      .activated.connect(callbackShortcut(Shortcut.ToggleFloatAll));
    this.shortcuts
      .getNextLayout()
      .activated.connect(callbackShortcut(Shortcut.NextLayout));
    this.shortcuts
      .getPreviousLayout()
      .activated.connect(callbackShortcut(Shortcut.PreviousLayout));

    this.shortcuts
      .getRotate()
      .activated.connect(callbackShortcut(Shortcut.Rotate));
    this.shortcuts
      .getRotatePart()
      .activated.connect(callbackShortcut(Shortcut.RotatePart));

    this.shortcuts
      .getSetMaster()
      .activated.connect(callbackShortcut(Shortcut.SetMaster));

    this.shortcuts
      .getRaiseSurfaceCapacity()
      .activated.connect(callbackShortcut(Shortcut.RaiseSurfaceCapacity));
    this.shortcuts
      .getLowerSurfaceCapacity()
      .activated.connect(callbackShortcut(Shortcut.LowerSurfaceCapacity));

    this.shortcuts
      .getKrohnkiteMeta()
      .activated.connect(callbackShortcut(Shortcut.KrohnkiteMeta));

    const callbackShortcutLayout = (layoutClass: ILayoutClass) => {
      return () => {
        LOG?.send(LogModules.shortcut, "shortcut layout", `${layoutClass.id}`);
        this.enter(() =>
          this.control.onShortcut(this, Shortcut.SetLayout, layoutClass.id),
        );
      };
    };

    this.shortcuts
      .getTileLayout()
      .activated.connect(callbackShortcutLayout(TileLayout));
    this.shortcuts
      .getMonocleLayout()
      .activated.connect(callbackShortcutLayout(MonocleLayout));
    this.shortcuts
      .getThreeColumnLayout()
      .activated.connect(callbackShortcutLayout(ThreeColumnLayout));
    this.shortcuts
      .getSpreadLayout()
      .activated.connect(callbackShortcutLayout(SpreadLayout));
    this.shortcuts
      .getStairLayout()
      .activated.connect(callbackShortcutLayout(StairLayout));
    this.shortcuts
      .getFloatingLayout()
      .activated.connect(callbackShortcutLayout(FloatingLayout));
    this.shortcuts
      .getQuarterLayout()
      .activated.connect(callbackShortcutLayout(QuarterLayout));
    this.shortcuts
      .getStackedLayout()
      .activated.connect(callbackShortcutLayout(StackedLayout));
    this.shortcuts
      .getColumnsLayout()
      .activated.connect(callbackShortcutLayout(ColumnsLayout));
    this.shortcuts
      .getSpiralLayout()
      .activated.connect(callbackShortcutLayout(SpiralLayout));
    this.shortcuts
      .getBTreeLayout()
      .activated.connect(callbackShortcutLayout(BinaryTreeLayout));
    this.shortcuts
      .getCascadeLayout()
      .activated.connect(callbackShortcutLayout(CascadeLayout));
  }

  /**
   * Binds callback to the signal w/ extra fail-safe measures, like re-entry
   * prevention and auto-disconnect on termination.
   */
  private connect(
    signal: Signal<(...args: any[]) => void>,
    handler: (..._: any[]) => void,
  ): () => void {
    const wrapper = (...args: any[]) => {
      /* HACK: `workspace` become undefined when the script is disabled. */
      if (typeof this.workspace === "undefined") signal.disconnect(wrapper);
      else this.enter(() => handler.apply(this, args));
    };
    signal.connect(wrapper);

    return wrapper;
  }

  /**
   * Run the given function in a protected(?) context to prevent nested event
   * handling.
   *
   * KWin emits signals as soon as window states are changed, even when
   * those states are modified by the script. This causes multiple re-entry
   * during event handling, resulting in performance degradation and harder
   * debugging.
   */
  private enter(callback: () => void) {
    if (this.entered) return;

    this.entered = true;
    try {
      callback();
    } catch (e: any) {
      const line = e && e.lineNumber !== undefined ? e.lineNumber : "unknown";
      warning(`ProtectFunc: Error raised line: ${line}. Error: ${String(e)}`);
    } finally {
      this.entered = false;
    }
  }
  //TODO: add signal Vdesktop.aboutToBeDestroyed
  //add signal workspace.activity.removed
  private bindEvents() {
    this.connect(this.workspace.screensChanged, () => {
      LOG?.send(LogModules.screensChanged, "eventFired");
      this.control.onSurfaceUpdate(this);
    });

    this.connect(this.workspace.virtualScreenGeometryChanged, () => {
      LOG?.send(LogModules.virtualScreenGeometryChanged, "eventFired");
      this.control.onSurfaceUpdate(this);
    });

    this.connect(
      this.workspace.currentActivityChanged,
      (activityId: string) => {
        LOG?.send(
          LogModules.currentActivityChanged,
          "eventFired",
          `Activity ID:${activityId}`,
        );
        this.control.onCurrentActivityChanged(this);
      },
    );

    this.connect(
      this.workspace.currentDesktopChanged,
      (virtualDesktop: VirtualDesktop) => {
        LOG?.send(
          LogModules.currentDesktopChanged,
          "eventFired",
          `Virtual Desktop. name:${virtualDesktop.name}, id:${virtualDesktop.id}`,
        );
        this.control.onSurfaceUpdate(this);
      },
    );

    this.connect(this.workspace.windowAdded, (client: Window) => {
      if (!client) return;
      LOG?.send(
        LogModules.windowAdded,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId}`,
        { winClass: [`${client.resourceClass}`] },
      );
      const window = this.addWindow(client);
      if (client.active && window !== null) {
        this.control.onWindowFocused(this, window);
        if (CONFIG.movePointerOnFocus) {
          DBUS.moveMouseToCenter(20);
        }
      }
    });

    this.connect(this.workspace.windowActivated, (client: Window) => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.windowActivated,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId}`,
        { winClass: [`${client.resourceClass}`] },
      );
      const window = this.windowMap.get(client);
      if (client.active && window !== null) {
        this.control.onWindowFocused(this, window);
      }
    });

    this.connect(this.workspace.windowRemoved, (client: Window) => {
      if (!client) return;
      LOG?.send(
        LogModules.windowRemoved,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId}`,
        { winClass: [`${client.resourceClass}`] },
      );
      if (client.dock) {
        // A dock is never added to windowMap, so the removal handling below
        // ignores it. Re-tile here instead so that windows expand into the area
        // previously reserved for the dock.
        this.control.onSurfaceUpdate(this);
        return;
      }
      const window = this.windowMap.get(client);
      if (window) {
        this.control.onWindowRemoved(this, window);
        this.windowMap.remove(client);
      }
    });
    this.connect(this.workspace.activityRemoved, (id: string) => {
      LOG?.send(
        LogModules.surfaceChanged,
        "eventFired",
        `Activity: id: ${id} has been removed.`,
      );
      this._surfaceStore.removeByActivity(id);
    });
    this.connect(this.workspace.desktopsChanged, () => {
      LOG?.send(
        LogModules.surfaceChanged,
        "eventFired",
        `Virtual Desktops Changed`,
      );
      this._surfaceStore.checkVirtualDesktops();
    });

    // TODO: options.configChanged.connect(this.onConfigChanged);
    /* NOTE: How disappointing. This doesn't work at all. Even an official kwin script tries this.
     *       https://github.com/KDE/kwin/blob/master/scripts/minimizeall/contents/code/main.js */
  }

  private bindWindowEvents(window: WindowClass, client: Window) {
    let moving = false;
    let resizing = false;
    this.connect(client.activitiesChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.activitiesChanged,
        "eventFired",
        `window: caption:${client.caption} internalID:${
          client.internalId
        }, activities: ${client.activities.join(",")}`,
        { winClass: [`${client.resourceClass}`] },
      );
      this.control.onWindowChanged(
        this,
        window,
        "activity=" + client.activities.join(","),
      );
    });

    this.connect(client.bufferGeometryChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.bufferGeometryChanged,
        "eventFired",
        `Window: caption:${client.caption} internalId:${client.internalId}, moving:${moving}, resizing:${resizing}, actualGeometry: ${window.actualGeometry}, commitGeometry:${window.geometry}`,
        { winClass: [`${client.resourceClass}`] },
      );
      if (moving) this.control.onWindowMove(window);
      else if (resizing) this.control.onWindowResize(this, window);
      else {
        if (!window.actualGeometry.equals(window.geometry))
          if (CONFIG.optVKeyboardSupport) {
            DBUS.checkVirtualKeyboardVisible((isVkVisible) => {
              if (
                !isVkVisible &&
                !window.actualGeometry.equals(window.geometry)
              )
                this.control.onWindowGeometryChanged(this, window);
            });
          } else {
            this.control.onWindowGeometryChanged(this, window);
          }
      }
    });

    this.connect(client.desktopsChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.desktopsChanged,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId}, desktops: ${client.desktops}`,
        { winClass: [`${client.resourceClass}`] },
      );
      this.control.onWindowChanged(this, window, "Window's desktop changed.");
    });

    this.connect(client.fullScreenChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.fullScreenChanged,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId}, fullscreen: ${client.fullScreen}`,
        { winClass: [`${client.resourceClass}`] },
      );
      this.control.onWindowChanged(
        this,
        window,
        "fullscreen=" + client.fullScreen,
      );
    });

    this.connect(client.interactiveMoveResizeStepped, (geometry) => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.interactiveMoveResizeStepped,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId},interactiveMoveResizeStepped:${geometry}`,
        { winClass: [`${client.resourceClass}`] },
      );
      if (client.resize) return;
      this.control.onWindowDragging(this, window, geometry);
    });

    this.connect(client.maximizedAboutToChange, (mode: MaximizeMode) => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.maximizedAboutToChange,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId},maximizedAboutToChange:${mode}`,
        { winClass: [`${client.resourceClass}`] },
      );
      // const maximized = mode === MaximizeMode.MaximizeFull;
      (window.window as KWinWindow).maximized = (mode as number) > 0;
      this.control.onWindowMaximizeChanged(this, window);
    });

    this.connect(client.minimizedChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.minimizedChanged,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId},minimized:${client.minimized}`,
        { winClass: [`${client.resourceClass}`] },
      );
      if (KWINCONFIG.preventMinimize) {
        client.minimized = false;
        this.workspace.activeWindow = client;
      } else {
        var comment = client.minimized ? "minimized" : "unminimized";
        this.control.onWindowChanged(this, window, comment);
      }
    });

    this.connect(client.moveResizedChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.moveResizedChanged,
        "eventFired",
        `Window: caption:${client.caption} internalId:${client.internalId}, moving:${moving}, resizing:${resizing}`,
        { winClass: [`${client.resourceClass}`] },
      );
      if (moving !== client.move) {
        moving = client.move;
        if (moving) {
          this.control.onWindowMoveStart(window);
        } else {
          this.control.onWindowMoveOver(this, window);
        }
      }
      if (resizing !== client.resize) {
        resizing = client.resize;
        if (resizing) this.control.onWindowResizeStart(window);
        else this.control.onWindowResizeOver(this, window);
      }
    });

    this.connect(client.outputChanged, () => {
      if (!client || client.deleted) return;
      LOG?.send(
        LogModules.outputChanged,
        "eventFired",
        `window: caption:${client.caption} internalID:${client.internalId} output: ${client.output.name}`,
        { winClass: [`${client.resourceClass}`] },
      );
      this.control.onWindowChanged(
        this,
        window,
        "screen=" + client.output.name,
      );
    });
    if (CONFIG.floatSkipPager) {
      this.connect(client.skipPagerChanged, () => {
        if (client.deleted) return;
        this.control.onWindowSkipPagerChanged(this, window, client.skipPager);
      });
    }
  }
}
