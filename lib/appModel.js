// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

/**
 * The state behind the dock: which apps are pinned, which others are
 * running, and which one has focus. It knows nothing about actors.
 *
 * Changes arrive in bursts (an app starting emits several state changes), so
 * they are coalesced into one `onChanged()` call per idle.
 */
export class AppModel {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._idleId = 0;

        // App id -> rank among running apps; see the `running` getter.
        this._launchRank = new Map();
        this._nextRank = 0;

        this._appSystem = Shell.AppSystem.get_default();
        this._tracker = Shell.WindowTracker.get_default();
        this._appFavorites = AppFavorites.getAppFavorites();

        const queue = () => this._queueChanged();
        this._signals = [
            [this._appSystem, this._appSystem.connect('app-state-changed', queue)],
            [this._appSystem, this._appSystem.connect('installed-changed', queue)],
            [this._appFavorites, this._appFavorites.connect('changed', queue)],
            [this._tracker, this._tracker.connect('notify::focus-app', queue)],
        ];
    }

    destroy() {
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._onChanged = null;
    }

    /** Pinned apps, in the user's order. */
    get favorites() {
        return this._appFavorites.getFavorites();
    }

    /**
     * Running apps that are not pinned, in a stable order.
     *
     * The shell hands running apps out in no particular order, and that order
     * changes from one call to the next. Each app is therefore given a rank
     * the first time it is seen and keeps it until it quits.
     *
     * @param {string} order - 'launch' or 'name'
     * @returns {Shell.App[]}
     */
    getRunning(order = 'launch') {
        const running = this._appSystem.get_running();

        const ids = new Set(running.map(app => app.get_id()));
        for (const id of this._launchRank.keys()) {
            if (!ids.has(id))
                this._launchRank.delete(id);
        }

        // Apps seen for the first time together (as when the extension is
        // enabled) are ranked by their oldest window, then by name.
        const firstWindow = app => Math.min(
            Infinity, ...app.get_windows().map(window => window.get_stable_sequence()));
        running
            .filter(app => !this._launchRank.has(app.get_id()))
            .sort((a, b) => firstWindow(a) - firstWindow(b) ||
                a.get_name().localeCompare(b.get_name()) ||
                a.get_id().localeCompare(b.get_id()))
            .forEach(app => this._launchRank.set(app.get_id(), this._nextRank++));

        const byLaunch = (a, b) =>
            this._launchRank.get(a.get_id()) - this._launchRank.get(b.get_id());
        const pinned = new Set(this.favorites.map(app => app.get_id()));
        return running
            .filter(app => !pinned.has(app.get_id()))
            .sort(order === 'name'
                ? (a, b) => a.get_name().localeCompare(b.get_name()) || byLaunch(a, b)
                : byLaunch);
    }

    get focusApp() {
        return this._tracker.focus_app;
    }

    isRunning(app) {
        return app.state !== Shell.AppState.STOPPED;
    }

    _queueChanged() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._onChanged?.();
            return GLib.SOURCE_REMOVE;
        });
    }
}
