// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** The windows of an app that a dock should care about, most recent first. */
export function appWindows(app) {
    return app.get_windows().filter(window => !window.skip_taskbar);
}

/**
 * What a click on an app icon does.
 *
 * @param {Shell.App} app
 * @param {object} params
 * @param {boolean} params.newWindow - open another window instead (middle click, Ctrl+click)
 * @param {boolean} params.focused - whether the app has focus right now
 * @param {string} params.focusedAction - 'cycle', 'minimize', 'minimize-or-cycle' or 'none'
 */
export function activateApp(app, {newWindow, focused, focusedAction}) {
    if (newWindow && app.can_open_new_window()) {
        app.open_new_window(-1);
        return;
    }

    const windows = appWindows(app);
    if (!focused || windows.length === 0) {
        app.activate();
        return;
    }

    if (focusedAction === 'none')
        return;

    if (focusedAction === 'cycle' ||
        (focusedAction === 'minimize-or-cycle' && windows.length > 1)) {
        // Most recently used first, so the last one is the next in line.
        if (windows.length > 1)
            Main.activateWindow(windows[windows.length - 1]);
        return;
    }

    const workspace = global.workspace_manager.get_active_workspace();
    for (const window of windows) {
        if (window.located_on_workspace(workspace) && window.can_minimize())
            window.minimize();
    }
}

/**
 * Steps through an app's windows in a fixed order, so that going one way and
 * back returns to where it started.
 *
 * @param {Shell.App} app
 * @param {number} step - +1 for the next window, -1 for the previous one
 */
export function cycleWindows(app, step) {
    const windows = appWindows(app);
    if (windows.length === 0)
        return;

    const focused = global.display.focus_window;
    if (!windows.includes(focused)) {
        Main.activateWindow(windows[0]);
        return;
    }

    const ordered = [...windows].sort(
        (a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    const index = ordered.indexOf(focused);
    const next = ordered[(index + step + ordered.length) % ordered.length];
    if (next !== focused)
        Main.activateWindow(next);
}
