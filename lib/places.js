// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const BATCH = 64;  // files asked for at a time when reading a directory

/** Opens a file or location with the app that handles it by default. */
export function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(
        uri, global.create_app_launch_context(0, -1), null, (_source, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
            } catch (e) {
                Main.notifyError('GlideDock', e.message);
            }
        });
}

/** @returns {Gio.File} the user's downloads folder */
export function downloadsFolder() {
    const path = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    return Gio.File.new_for_path(path);
}

// Everything in a directory, as [{info, file}], without blocking the shell.
async function listChildren(directory, attributes, cancellable) {
    const enumerator = await directory.enumerate_children_async(
        attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const children = [];
    try {
        let infos;
        do {
            infos = await enumerator.next_files_async(BATCH, GLib.PRIORITY_DEFAULT, cancellable);
            for (const info of infos)
                children.push({info, file: enumerator.get_child(info)});
        } while (infos.length > 0);
    } finally {
        enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
    return children;
}

/**
 * The trash: whether there is anything in it, and how to empty it.
 *
 * It only reports; what the dock shows for it is the dock's business.
 */
export class Trash {
    /**
     * @param {Function} onChanged - called when the trash becomes empty or stops being empty
     */
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._file = Gio.File.new_for_uri('trash:///');
        this._cancellable = new Gio.Cancellable();
        this._full = false;
        this._refreshing = false;
        this._stale = false;

        // Without gvfs there is no trash to watch; it then simply stays empty.
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._refresh());
        } catch {
            this._monitor = null;
        }
        this._refresh();
    }

    destroy() {
        this._cancellable.cancel();
        this._monitor?.disconnect(this._monitorId);
        this._monitor?.cancel();
        this._monitor = null;
        this._onChanged = null;
    }

    get uri() {
        return this._file.get_uri();
    }

    get full() {
        return this._full;
    }

    get iconName() {
        return this._full ? 'user-trash-full' : 'user-trash';
    }

    // Emptying a big trash reports every file. One query runs at a time, and
    // one more after it if anything changed in the meantime.
    async _refresh() {
        if (this._refreshing) {
            this._stale = true;
            return;
        }
        this._refreshing = true;

        let count = 0;
        try {
            do {
                this._stale = false;
                const info = await this._file.query_info_async(
                    'trash::item-count', Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_DEFAULT, this._cancellable);
                count = info.get_attribute_uint32('trash::item-count');
            } while (this._stale);
        } catch {
            // Destroyed, or no trash: nothing to show either way.
        } finally {
            this._refreshing = false;
        }
        if (this._cancellable.is_cancelled())
            return;

        const full = count > 0;
        if (full !== this._full) {
            this._full = full;
            this._onChanged();
        }
    }

    /** Deletes everything in the trash, for good. */
    async empty() {
        try {
            const children = await listChildren(this._file, 'standard::name', this._cancellable);
            // Folders go in one piece: the trash deletes what is inside them.
            await Promise.allSettled(children.map(({file}) =>
                file.delete_async(GLib.PRIORITY_DEFAULT, this._cancellable)));
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                Main.notifyError('GlideDock', e.message);
        }
    }
}

/** A folder pinned to the dock. */
export class Folder {
    /**
     * @param {Gio.File} file
     */
    constructor(file) {
        this._file = file;
        this._cancellable = new Gio.Cancellable();
    }

    destroy() {
        this._cancellable.cancel();
    }

    get uri() {
        return this._file.get_uri();
    }

    /**
     * The files changed last, newest first. Hidden files are left out.
     *
     * @param {number} count - how many at most
     * @returns {Promise<{name: string, icon: Gio.Icon, uri: string}[]>} icon is a thumbnail if there is one
     */
    async listRecent(count) {
        let children;
        try {
            children = await listChildren(this._file,
                'standard::name,standard::display-name,standard::icon,standard::is-hidden,' +
                'time::modified,thumbnail::path',
                this._cancellable);
        } catch {
            // Destroyed, or the folder is not there.
            return [];
        }

        // A picture of the file itself where the file manager has made one.
        const thumbnail = info => {
            const path = info.get_attribute_byte_string('thumbnail::path');
            return path ? new Gio.FileIcon({file: Gio.File.new_for_path(path)}) : null;
        };
        const modified = ({info}) => info.get_attribute_uint64('time::modified');
        return children
            .filter(({info}) => !info.get_is_hidden())
            .sort((a, b) => modified(b) - modified(a))
            .slice(0, count)
            .map(({info, file}) => ({
                name: info.get_display_name(),
                icon: thumbnail(info) ?? info.get_icon(),
                uri: file.get_uri(),
            }));
    }
}
