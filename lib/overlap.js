// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

// Window types that can push an auto-hiding dock away.
const WINDOW_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

/**
 * Watches whether any window on the active workspace overlaps a rectangle.
 * `onChanged()` is called whenever the answer may have changed.
 */
export class OverlapTracker {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._rect = null;
        this._overlapped = false;
        this._idleId = 0;
        this._windows = new Map();

        this._signals = [
            [global.display, global.display.connect('window-created',
                (_display, window) => this._track(window))],
            [global.window_manager, global.window_manager.connect('switch-workspace',
                () => this._queueCheck())],
        ];
        for (const actor of global.get_window_actors())
            this._track(actor.meta_window);
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        for (const window of [...this._windows.keys()])
            this._untrack(window);
        this._onChanged = null;
    }

    get overlapped() {
        return this._overlapped;
    }

    /** @param {{x: number, y: number, width: number, height: number}?} rect - in stage coordinates */
    setRect(rect) {
        this._rect = rect;
        this._queueCheck();
    }

    _track(window) {
        if (!window || this._windows.has(window))
            return;
        const check = () => this._queueCheck();
        this._windows.set(window, [
            window.connect('position-changed', check),
            window.connect('size-changed', check),
            window.connect('notify::minimized', check),
            window.connect('workspace-changed', check),
            window.connect('unmanaged', () => {
                this._untrack(window);
                check();
            }),
        ]);
        check();
    }

    _untrack(window) {
        for (const id of this._windows.get(window) ?? [])
            window.disconnect(id);
        this._windows.delete(window);
    }

    // Window moves arrive in bursts; one check per idle is plenty.
    _queueCheck() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._check();
            return GLib.SOURCE_REMOVE;
        });
    }

    _check() {
        const rect = this._rect;
        const workspace = global.workspace_manager.get_active_workspace();
        this._overlapped = !!rect && [...this._windows.keys()].some(window => {
            if (window.minimized ||
                !window.located_on_workspace(workspace) ||
                !WINDOW_TYPES.includes(window.window_type))
                return false;
            const frame = window.get_frame_rect();
            return frame.x < rect.x + rect.width && frame.x + frame.width > rect.x &&
                frame.y < rect.y + rect.height && frame.y + frame.height > rect.y;
        });
        this._onChanged?.();
    }
}
