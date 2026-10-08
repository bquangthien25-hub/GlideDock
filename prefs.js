// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Builds preference rows bound to GSettings keys. Every row saves as soon as
 * it changes and follows changes made elsewhere, so there is nothing to apply.
 */
class RowBuilder {
    constructor(window, settings) {
        this._window = window;
        this._settings = settings;
        this._page = null;
    }

    page(title, iconName) {
        this._page = new Adw.PreferencesPage({title, icon_name: iconName});
        this._window.add(this._page);
    }

    /** Adds a group to the page added last. */
    group(title, description = null) {
        // Group titles and descriptions are markup; ours are plain text.
        const escape = text => text === null ? null : GLib.markup_escape_text(text, -1);
        const group = new Adw.PreferencesGroup({
            title: escape(title),
            description: escape(description),
        });
        this._page.add(group);
        return group;
    }

    switch(group, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle, use_markup: false});
        this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    spin(group, key, title, subtitle, [min, max, step], digits = 0) {
        const row = Adw.SpinRow.new_with_range(min, max, step);
        row.set({title, subtitle, digits, use_markup: false});
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    /**
     * A drop-down over a string or boolean key. `choices` is a list of
     * [value, label]; value is what the key holds while that label is selected.
     */
    combo(group, key, title, subtitle, choices) {
        const settings = this._settings;
        const row = new Adw.ComboRow({
            title,
            subtitle,
            use_markup: false,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });

        const type = settings.get_value(key).get_type_string();
        const read = () => settings.get_value(key).unpack();
        const sync = () => {
            const index = choices.findIndex(([value]) => value === read());
            row.selected = Math.max(index, 0);
        };
        sync();
        row.connect('notify::selected', () => {
            const [value] = choices[row.selected];
            if (read() !== value)
                settings.set_value(key, new GLib.Variant(type, value));
        });
        const changedId = settings.connect(`changed::${key}`, sync);
        this._window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });

        group.add(row);
        return row;
    }

    /** Makes rows usable only while a switch row is on. */
    dependOn(switchRow, ...rows) {
        for (const row of rows)
            switchRow.bind_property('active', row, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
    }
}

export default class GlideDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const rows = new RowBuilder(window, this.getSettings());
        // Wide enough for the four tab names in the header bar.
        window.set_default_size(860, 720);

        this._addPositionPage(rows);
        this._addLaunchersPage(rows);
        this._addBehaviorPage(rows);
        this._addAppearancePage(rows);
    }

    _addPositionPage(rows) {
        rows.page(_('Position & Size'), 'preferences-desktop-display-symbolic');

        const placement = rows.group(_('Screen & Position'));
        rows.combo(placement, 'position',
            _('Position on screen'), _('Screen edge the dock is attached to'), [
                ['bottom', _('Bottom')],
                ['left', _('Left')],
                ['right', _('Right')],
            ]);
        rows.combo(placement, 'alignment',
            _('Alignment'), _('Where the dock sits along that edge'), [
                ['center', _('Center')],
                ['start', _('Start')],
                ['end', _('End')],
            ]);

        rows.switch(placement, 'show-in-overview',
            _('Show in the overview'), _('Keep the dock in the overview in place of the built-in dash'));

        const size = rows.group(_('Icon Size'));
        rows.spin(size, 'icon-size',
            _('Icon size'), _('Size at rest, in pixels'), [24, 96, 2]);
        rows.spin(size, 'icon-spacing',
            _('Icon spacing'), _('Extra space between icons, in pixels'), [2, 16, 1]);
        rows.spin(size, 'dock-padding',
            _('Dock padding'), _('Space between the icons and the border of the dock, in pixels'), [0, 24, 1]);
    }

    _addLaunchersPage(rows) {
        rows.page(_('Launchers'), 'view-app-grid-symbolic');

        const showApps = rows.group(_('Show Apps Button'));
        const showAppsSwitch = rows.switch(showApps, 'show-apps-button',
            _('Show Apps button'), _('Add a button that opens the app grid'));
        rows.dependOn(showAppsSwitch, rows.combo(showApps, 'show-apps-at-start',
            _('Button position'), _('Where the button sits among the icons'), [
                [true, _('At the start')],
                [false, _('At the end')],
            ]));

        const running = rows.group(_('Running Apps'),
            _('Apps that are running but not pinned are listed after the pinned ones.'));
        rows.switch(running, 'show-separator',
            _('Separator'), _('Draw a line between pinned apps and other running apps'));
        rows.switch(running, 'show-running-dots',
            _('Running indicators'), _('Mark running apps with a dot'));
        rows.combo(running, 'running-apps-order',
            _('Order of running apps'), _('Either way, icons never change places on their own'), [
                ['launch', _('Order they were started')],
                ['name', _('Name')],
            ]);

        const places = rows.group(_('macOS Special Launchers'),
            _('Shown at the end of the dock, after the apps.'));
        rows.switch(places, 'show-trash',
            _('Show Trash'), _('Its icon tells whether it holds anything; right-click to empty it'));
        const downloads = rows.switch(places, 'show-downloads',
            _('Show Downloads Folder'), _('Right-click for the files changed last'));
        rows.dependOn(downloads, rows.switch(places, 'stacks-fan-view',
            _('Stacks Fan View'), _('Click the folder to fan out its latest files instead of opening it')));
        rows.switch(places, 'show-places-separator',
            _('Separate special items with divider'), _('Draw a line between the apps and these items'));
    }

    _addBehaviorPage(rows) {
        rows.page(_('Behavior'), 'input-mouse-symbolic');

        const autoHide = rows.group(_('Auto-hide'));
        const intellihide = rows.switch(autoHide, 'intellihide',
            _('Intellihide'), _('Hide the dock while a window overlaps it; windows may then use the whole screen'));
        rows.dependOn(intellihide,
            rows.spin(autoHide, 'hide-delay',
                _('Hide delay'), _('Milliseconds before the dock hides after the pointer leaves'), [0, 2000, 50]),
            rows.spin(autoHide, 'show-delay',
                _('Show delay'), _('Milliseconds the pointer must rest on the screen edge'), [0, 2000, 50]));

        const actions = rows.group(_('Mouse Actions'));
        rows.combo(actions, 'click-action',
            _('Click on the focused app'), _('What clicking its icon again does'), [
                ['cycle', _('Cycle through windows')],
                ['minimize', _('Minimize')],
                ['minimize-or-cycle', _('Minimize, or cycle if several windows')],
                ['none', _('Do nothing')],
            ]);
        rows.switch(actions, 'scroll-to-switch',
            _('Scroll to switch windows'), _('Scrolling over an app icon steps through its windows'));
    }

    _addAppearancePage(rows) {
        rows.page(_('Appearance'), 'preferences-desktop-appearance-symbolic');

        const magnification = rows.group(_('Magnification'));
        const magnify = rows.switch(magnification, 'enable-magnification',
            _('Magnify on hover'), _('Icons near the pointer grow'));
        rows.dependOn(magnify, rows.spin(magnification, 'max-scale',
            _('Maximum scale'), _('Size of the icon under the pointer, relative to its size at rest'), [1, 2, 0.05], 2));

        const background = rows.group(_('Background & Blur'));
        rows.spin(background, 'dock-opacity',
            _('Background opacity'), _('0 is fully transparent, 1 is opaque'), [0, 1, 0.05], 2);
        rows.spin(background, 'corner-radius',
            _('Corner radius'), _('Roundness of the dock, in pixels'), [0, 40, 1]);
        const blur = rows.switch(background, 'enable-blur',
            _('Blur background'), _('Show the wallpaper blurred behind the dock'));
        rows.dependOn(blur,
            rows.spin(background, 'blur-sigma',
                _('Blur strength'), _('Higher is blurrier'), [1, 100, 1]),
            rows.spin(background, 'blur-brightness',
                _('Blur brightness'), _('0 is black, 1 leaves the wallpaper unchanged'), [0, 1, 0.05], 2));
    }
}
