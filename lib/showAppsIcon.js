// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const STYLE_CLASS = 'glidedock-show-apps';

/**
 * The one Show Apps icon, for the dock and for the shell's own dash.
 *
 * Looking 'view-app-grid' up in the icon theme gives a different picture
 * depending on the theme and on the size asked for, and shell themes such as
 * WhiteSur go further and paint a coloured image over the dash's button from
 * their stylesheet. So the icon is a file of ours, and it never carries the
 * style class those themes target.
 */
export class ShowAppsIcon {
    /**
     * @param {Gio.File} extensionDir - where the extension's own files are
     */
    constructor(extensionDir) {
        this._gicon = new Gio.FileIcon({
            file: extensionDir.get_child('icons').get_child('glidedock-show-apps-symbolic.svg'),
        });
        this._dashIcon = null;
        this._createDashIcon = null;
    }

    /**
     * @param {number} size - icon size, in logical pixels
     * @returns {St.Icon}
     */
    create(size) {
        return this._restyle(new St.Icon({icon_size: size}));
    }

    _restyle(icon) {
        icon.gicon = this._gicon;
        icon.style_class = STYLE_CLASS;
        return icon;
    }

    // The shell's dash builds its Show Apps icon again whenever its icon size
    // changes. Its own function still makes the actor, since the dash keeps
    // track of that one; only the picture and the style class are replaced.
    overrideDash() {
        const dashIcon = Main.overview.dash?.showAppsButton?.child;
        if (!dashIcon?.createIcon || this._dashIcon)
            return;

        this._dashIcon = dashIcon;
        this._createDashIcon = dashIcon.createIcon;
        dashIcon.createIcon = size => this._restyle(this._createDashIcon(size));
        dashIcon.update();
    }

    restoreDash() {
        const dashIcon = this._dashIcon;
        if (!dashIcon)
            return;

        dashIcon.createIcon = this._createDashIcon;
        this._dashIcon = null;
        this._createDashIcon = null;
        // Gone already when the shell itself is shutting down.
        if (Main.overview.dash?.showAppsButton?.child === dashIcon)
            dashIcon.update();
    }
}
