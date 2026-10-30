// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {startProcess} from './subprocess.js';

const NEAR = 160;     // logical px around the dock at which the drop window is made ready
const LINGER = 1500;  // ms the drop window waits after a drag, for a drop still on its way

/**
 * Lets files dragged from other apps be dropped on the dock.
 *
 * The shell learns where a drag from another app is, but not what it
 * carries, and it cannot take a drop: on Wayland only a window can. So as
 * soon as a drag comes near the dock, a transparent window of a helper
 * program (helper/dropTarget.js) is laid over the dock to take the drop. It
 * sits below the dock, which lets the pointer through to it while a drag is
 * on (see `dragging`), so the dock itself is what shows the drop target.
 *
 * Starting the helper takes a moment, which is why it starts on the way to
 * the dock and not on arrival.
 */
export class DropZone {
    /**
     * @param {object} params
     * @param {string} params.helperPath - helper/dropTarget.js
     * @param {string[]} params.suffixes - file name endings that may be dropped, lower case
     * @param {Function} params.getRect - the dock on screen, {x, y, width, height},
     *   or null while it cannot take a drop
     * @param {Function} params.onChanged - called when `dragging`, `over` or `accept` changes
     * @param {Function} params.onDrop - called with the paths of the files dropped
     */
    constructor({helperPath, suffixes, getRect, onChanged, onDrop}) {
        this._helperPath = helperPath;
        this._suffixes = suffixes;
        this._getRect = getRect;
        this._onChanged = onChanged;
        this._onDrop = onDrop;

        this._dragging = false;
        this._over = false;
        this._accept = null;
        this._helper = null;
        this._helperRect = null;
        this._windows = new Map();  // the helper's windows -> their signal ids
        this._lingerId = 0;

        this._gjs = GLib.find_program_in_path('gjs');
        if (!this._gjs)
            console.warn('GlideDock: gjs is not installed; dropping files on the dock will not work');

        const dnd = (global.backend ?? Meta.get_backend()).get_dnd();
        this._signals = [
            [dnd, dnd.connect('dnd-enter', () => this._onDragBegin())],
            [dnd, dnd.connect('dnd-position-change', (_dnd, x, y) => this._onDragMotion(x, y))],
            [dnd, dnd.connect('dnd-leave', () => this._onDragEnd())],
            [global.display, global.display.connect('window-created',
                (_display, window) => this._onWindowCreated(window))],
        ];
    }

    destroy() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._onChanged = null;
        this._onDrop = null;
        this._stopHelper();
        for (const [window, ids] of this._windows)
            ids.forEach(id => window.disconnect(id));
        this._windows.clear();
    }

    /** Whether files, or anything else, are being dragged by another app. */
    get dragging() {
        return this._dragging;
    }

    /** Whether the drag is over the dock. */
    get over() {
        return this._over;
    }

    /** Whether what is dragged over the dock can be installed; null while unknown. */
    get accept() {
        return this._over ? this._accept : null;
    }

    /** Whether a window is the helper's, which nothing should show. */
    ownsWindow(window) {
        // Known by its window until that goes, which may be after the helper.
        return this._windows.has(window) ||
            (!!this._helper && window.get_pid() === this._helper.pid);
    }

    _onDragBegin() {
        // A helper still waiting for the last drag is of no use for this one.
        this._stopHelper();
        this._dragging = true;
        this._changed();
    }

    _onDragMotion(x, y) {
        const rect = this._getRect();
        const inside = (margin = 0) => !!rect &&
            x >= rect.x - margin && x < rect.x + rect.width + margin &&
            y >= rect.y - margin && y < rect.y + rect.height + margin;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (!this._helper && inside(NEAR * scale))
            this._startHelper(rect);

        const over = inside();
        if (over !== this._over) {
            this._over = over;
            this._changed();
        }
    }

    _onDragEnd() {
        this._dragging = false;
        this._over = false;
        this._accept = null;
        this._changed();

        // The drop reaches the helper after the drag has ended.
        if (this._helper && !this._lingerId) {
            this._lingerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER, () => {
                this._lingerId = 0;
                this._stopHelper();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _changed() {
        this._onChanged?.();
    }

    _startHelper(rect) {
        if (!this._gjs)
            return;

        try {
            const helper = startProcess(
                [this._gjs, '-m', this._helperPath,
                    String(rect.width), String(rect.height), ...this._suffixes],
                line => this._onHelperMessage(helper, line));
            this._helper = helper;
            this._helperRect = rect;
            helper.wait.then(() => {
                if (this._helper === helper)
                    this._stopHelper();
            });
        } catch (e) {
            console.warn(`GlideDock: could not start the drop target: ${e.message}`);
        }
    }

    _stopHelper() {
        if (this._lingerId) {
            GLib.source_remove(this._lingerId);
            this._lingerId = 0;
        }
        const helper = this._helper;
        this._helper = null;
        this._helperRect = null;
        helper?.stop();
        if (this._accept !== null) {
            this._accept = null;
            this._changed();
        }
    }

    _onHelperMessage(helper, line) {
        if (helper !== this._helper)
            return;

        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }

        switch (message.event) {
        case 'hover':
            this._accept = !!message.accept;
            this._changed();
            break;
        case 'leave':
            this._accept = null;
            this._changed();
            break;
        case 'drop': {
            const paths = (message.paths ?? []).filter(path => typeof path === 'string');
            this._stopHelper();
            if (paths.length > 0)
                this._onDrop?.(paths);
            break;
        }
        }
    }

    _onWindowCreated(window) {
        if (!this._helper || window.get_pid() !== this._helper.pid)
            return;

        // Nobody is meant to see it, whatever the GTK theme paints: a user
        // theme in ~/.config/gtk-4.0 can give it an opaque background. The
        // surfaces inside the window actor are made transparent rather than
        // the actor itself, whose opacity the shell's map animation resets.
        // Fully transparent actors still take the pointer.
        const actor = window.get_compositor_private();
        const hide = child => {
            child.opacity = 0;
        };
        if (actor) {
            Main.wm.skipNextEffect?.(actor);
            actor.get_children().forEach(hide);
        }
        const actorId = actor?.connect('child-added', (_actor, child) => hide(child)) ?? 0;

        // Moved once it is on screen: a Wayland window that is moved or
        // resized before its first frame may never get to show one.
        const ids = [
            window.connect('shown', () => {
                actor?.get_children().forEach(hide);
                this._placeWindow(window);
            }),
            window.connect('unmanaged', () => {
                ids.forEach(id => window.disconnect(id));
                if (actorId)
                    actor.disconnect(actorId);
                this._windows.delete(window);
            }),
        ];
        this._windows.set(window, ids);
    }

    // Over the dock, on every workspace, above every other window. As a
    // move "by the user", so that it is not pushed off the space the dock
    // keeps for itself.
    _placeWindow(window) {
        const rect = this._helperRect;
        if (!rect || !this.ownsWindow(window))
            return;
        window.make_above();
        window.stick();
        window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    }
}
