// SPDX-License-Identifier: GPL-2.0-or-later
//
// The launchers that system packages (RPM, DEB) install.
//
// Only Gio and GLib are used here, nothing of the shell, so that this file
// can be tried out with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const DESKTOP_GROUP = 'Desktop Entry';

/** Where system packages put their launchers. */
export const APPLICATIONS_DIR = '/usr/share/applications';

/**
 * Of the launchers a system package installs, the one to pin: one that is
 * shown in menus, preferably named after the package.
 *
 * @param {string} packageName
 * @param {string[]} launchers - desktop file ids the package installs
 * @param {Gio.File} dir - where they are, /usr/share/applications
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<{desktopId: string, name: string}|null>}
 */
export async function pickLauncher(packageName, launchers, dir, cancellable) {
    const candidates = [];
    for (const desktopId of launchers) {
        // eslint-disable-next-line no-await-in-loop
        const entry = await readLauncher(dir.get_child(desktopId), cancellable);
        if (entry && !entry.hidden)
            candidates.push({desktopId, name: entry.name});
    }
    const named = name => name.toLowerCase().includes(packageName.toLowerCase());
    return candidates.find(({desktopId}) => named(desktopId)) ?? candidates[0] ?? null;
}

async function readLauncher(file, cancellable) {
    try {
        const [contents] = await file.load_contents_async(cancellable);
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_bytes(new GLib.Bytes(contents), GLib.KeyFileFlags.KEEP_TRANSLATIONS);
        const flag = key => {
            try {
                return keyFile.get_boolean(DESKTOP_GROUP, key);
            } catch {
                return false;
            }
        };
        let type = 'Application';
        try {
            type = keyFile.get_string(DESKTOP_GROUP, 'Type');
        } catch {
            // Application, then.
        }
        return {
            name: keyFile.get_locale_string(DESKTOP_GROUP, 'Name', null),
            hidden: type !== 'Application' || flag('NoDisplay') || flag('Hidden'),
        };
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return null;
    }
}
