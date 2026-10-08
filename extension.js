// SPDX-License-Identifier: GPL-2.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dock} from './lib/dock.js';

export default class GlideDockExtension extends Extension {
    enable() {
        this._dock = new Dock(this.getSettings(), this.dir);
    }

    disable() {
        this._dock?.destroy();
        this._dock = null;
    }
}
