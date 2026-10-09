// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {activateApp, cycleWindows} from './appActions.js';
import {AppModel} from './appModel.js';
import {BlurLayer} from './blur.js';
import {bounceUntil} from './bounce.js';
import {Magnifier} from './magnifier.js';
import {OverlapTracker} from './overlap.js';
import {Folder, Trash, downloadsFolder, openUri} from './places.js';
import {ShowAppsIcon} from './showAppsIcon.js';
import {FanStack} from './stacks.js';

// All sizes are in logical pixels; they are multiplied by the St scale factor.
const DOT_SIZE = 5;
const DOT_GAP = 2;           // space between icon and running dot
const EDGE_MARGIN = 8;       // space kept from the screen corner when aligned to start or end
const EDGE_SIZE = 1;         // thickness of the screen-edge strip that reveals a hidden dock
const LABEL_GAP = 8;         // space between a fully magnified icon and the label
const MAGNIFY_RANGE = 2.35;  // pointer distance, in magnified icon sizes, at which magnification fades to zero
const FAR = 10000;           // "unbounded" extent for the one-sided clip

const FADE_TIME = 150;       // ms; fade around the overview
const SLIDE_TIME = 220;      // ms; auto-hide slide
const REVEAL_GRACE = 600;    // ms a revealed dock waits for the pointer before hiding again
const SCROLL_INTERVAL = 150; // ms; minimum time between two window switches by scrolling

const POSITIONS = ['bottom', 'left', 'right'];
const SHOW_APPS_KEY = '::show-apps';
const SEPARATOR_KEY = '::separator';
const PLACES_SEPARATOR_KEY = '::places-separator';
const DOWNLOADS_KEY = '::downloads';
const TRASH_KEY = '::trash';
const RECENT_FILES = 8;      // files listed for the downloads folder, in its stack and in its menu
const BOUNCE_HEIGHT = 0.4;   // how far a launching app's icon jumps, in icon sizes

// Settings that only restyle the dock, only change which icons it holds, or
// are simply read when needed. Any key in none of these sets changes the
// geometry of the icons and rebuilds them.
const STYLE_KEYS = new Set(['dock-opacity', 'corner-radius', 'icon-spacing', 'dock-padding']);
const ITEM_KEYS = new Set([
    'show-apps-button', 'show-apps-at-start', 'show-separator',
    'show-running-dots', 'running-apps-order',
    'show-trash', 'show-downloads', 'show-places-separator',
]);
const BLUR_KEYS = new Set(['enable-blur', 'blur-sigma', 'blur-brightness']);
const LIVE_KEYS = new Set([
    'hide-delay', 'show-delay', 'click-action', 'scroll-to-switch', 'stacks-fan-view',
]);

/**
 * The dock on screen: its actors, where they sit, and how they react.
 *
 * Actor tree:
 *
 *   container   fixed footprint on screen, tracked by the layout manager
 *   └ content      the only thing that moves when the dock auto-hides
 *     ├ backdrop   the visible bar; stretched when icons are magnified
 *     │ ├ blur        optional, see blur.js
 *     │ └ background  colour, border and shadow
 *     └ dock       the row of icons; one fixed-size button per icon
 *
 * Plus two siblings on the stage: the label (one shared tooltip) and the
 * edge strip that reveals a hidden dock.
 */
export class Dock {
    /**
     * @param {Gio.Settings} settings
     * @param {Gio.File} extensionDir - where the extension's own files are
     */
    constructor(settings, extensionDir) {
        this._settings = settings;

        // The same icon in the dock and in the shell's dash, so that the
        // button looks alike whichever of the two the overview shows.
        this._showAppsIcon = new ShowAppsIcon(extensionDir);
        this._showAppsIcon.overrideDash();
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._signals = [];

        // View state.
        this._entries = [];      // what is in the dock, in order: {key, actor, item?}
        this._items = [];        // the entries that are icons
        this._layoutKey = null;
        this._labelItem = null;
        this._dockRect = null;
        this._inOverview = Main.overview.visible;
        this._replacesDash = false;
        this._chromeAdded = false;
        this._scrollAccumulated = 0;
        this._scrollTime = 0;

        // Places: the downloads folder and the trash, at the end of the dock.
        this._downloads = null;
        this._trash = null;
        this._openMenu = null;
        this._stack = null;
        this._emptyTrashDialog = null;

        // Auto-hide state.
        this._intellihide = false;
        this._overlap = null;
        this._dockHidden = false;
        this._revealed = false;
        this._sliding = false;
        this._slideId = 0;
        this._hideTimerId = 0;
        this._showTimerId = 0;
        this._revealTimerId = 0;

        this._geometryIdleId = 0;
        this._windowSerial = 0;  // counts windows as they appear; see _bounce

        this._createActors();
        this._magnifier = new Magnifier(this._container);
        this._magnifier.setBackdrop(this._backdrop);
        this._menuManager = new PopupMenu.PopupMenuManager(this._container);
        this._model = new AppModel(() => this._syncItems());

        this._connect(this._settings, 'changed', (_settings, key) => {
            if (STYLE_KEYS.has(key))
                this._applyStyle();
            else if (BLUR_KEYS.has(key))
                this._applyBlur();
            else if (ITEM_KEYS.has(key))
                this._syncItems();
            else if (key === 'alignment')
                this._reposition();
            else if (key === 'intellihide')
                this._applyIntellihide();
            else if (key === 'show-in-overview')
                this._applyOverviewMode();
            else if (!LIVE_KEYS.has(key))
                this._applyLayout();
        });
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            // The blur shows a specific monitor's wallpaper.
            this._destroyBlur();
            this._applyBlur();
            this._reposition();
            this._syncVisible();
        });
        this._connect(this._themeContext, 'notify::scale-factor', () => {
            this._applyBlur();
            this._applyLayout();
        });
        this._connect(Main.overview, 'showing', () => this._setInOverview(true));
        this._connect(Main.overview, 'hiding', () => this._setInOverview(false));
        // Normally there is nothing left to do by then; they only make sure
        // the dock can never be left believing in an overview that is gone.
        this._connect(Main.overview, 'shown', () => this._setInOverview(true));
        this._connect(Main.overview, 'hidden', () => this._setInOverview(false));
        this._connect(global.display, 'in-fullscreen-changed', () => this._syncVisible());
        this._connect(global.display, 'notify::focus-window', () => this._syncVisible());
        this._connect(global.display, 'window-created', () => {
            this._windowSerial++;
            this._queueIconGeometry();
        });

        this._applyStyle();
        this._applyIntellihide();
        this._applyBlur();
        this._applyLayout();
        this._applyOverviewMode();
    }

    destroy() {
        Main.layoutManager.removeChrome(this._edge);
        this._edge.destroy();
        this._edge = null;

        Main.layoutManager.removeChrome(this._container);
        this._container.destroy();
        this._container = null;
        this._content = null;
        this._backdrop = null;
        this._background = null;
        this._dock = null;

        this._label.destroy();
        this._label = null;
    }

    // Everything that is not an actor of ours is released here. It also runs
    // when the shell tears the stage down without disabling the extension
    // first, so that nothing calls back into disposed actors.
    _onDestroy() {
        for (const timer of ['_hideTimerId', '_showTimerId', '_revealTimerId', '_geometryIdleId'])
            this._clearTimer(timer);
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];

        this._magnifier.destroy();
        this._magnifier = null;
        this._model.destroy();
        this._model = null;
        this._emptyTrashDialog?.destroy();
        this._emptyTrashDialog = null;
        // Forgotten first: its farewell must not reach a dock that is going away.
        const stack = this._stack;
        this._stack = null;
        stack?.destroy();
        this._downloads?.destroy();
        this._downloads = null;
        this._trash?.destroy();
        this._trash = null;
        this._menuManager = null;
        this._overlap?.destroy();
        this._overlap = null;
        this._destroyBlur();
        this._setReplacesDash(false);
        this._clearIconGeometry();
        this._showAppsIcon.restoreDash();
        this._showAppsIcon = null;

        this._settings = null;
        this._entries = [];
        this._items = [];
        this._labelItem = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _clearTimer(name) {
        if (this[name]) {
            GLib.source_remove(this[name]);
            this[name] = 0;
        }
    }

    _createActors() {
        this._dock = new St.BoxLayout({
            style_class: 'glidedock',
            x_expand: true,
            y_expand: true,
        });
        this._background = new St.Widget({
            style_class: 'glidedock-background',
            x_expand: true,
            y_expand: true,
        });
        this._backdrop = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._backdrop.add_child(this._background);

        this._content = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._backdrop);
        this._content.add_child(this._dock);

        // Padding (see stylesheet) keeps the dock off the screen edge.
        this._container = new St.Widget({
            style_class: 'glidedock-container',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
        });
        this._container.add_child(this._content);

        // Pointer events only record where the pointer is; the magnifier
        // does its work once per frame.
        this._container.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            this._magnifier.setPointer(this._vertical ? y : x);
            return Clutter.EVENT_PROPAGATE;
        });
        this._container.connect('notify::hover', () => {
            if (!this._container.hover)
                this._magnifier.setPointer(null);
            this._updateVisibility();
        });
        this._container.connect('notify::width', () => this._reposition());
        this._container.connect('notify::height', () => this._reposition());
        this._container.connect('notify::allocation', () => {
            this._magnifier.invalidate();
            this._syncBlur();
            this._syncClip();
        });
        this._dock.connect('notify::allocation', () => {
            this._magnifier.invalidate();
            this._queueIconGeometry();
        });
        this._container.connect('destroy', () => this._onDestroy());

        // The one and only label. It lives on uiGroup, outside the dock's
        // actor tree, so nothing that scales or relayouts can ever move it.
        this._label = new St.Label({style_class: 'glidedock-label', visible: false});
        Main.layoutManager.uiGroup.add_child(this._label);
        // The label fades with the dock around the overview instead of
        // popping in over a dock that is still transparent.
        this._container.bind_property('opacity', this._label, 'opacity',
            GObject.BindingFlags.SYNC_CREATE);

        // While the dock is hidden its container is too, so that clicks reach
        // the windows underneath. This strip along the screen edge is what
        // the pointer pushes against to bring the dock back.
        this._edge = new Clutter.Actor({reactive: true, visible: false});
        Main.layoutManager.addChrome(this._edge);
        this._edge.connect('enter-event', () => this._onEdgeEntered());
        this._edge.connect('leave-event', () => this._clearTimer('_showTimerId'));
    }

    // Settings

    _applyLayout() {
        this._position = this._settings.get_string('position');
        this._vertical = this._position !== 'bottom';

        // With magnification off the two sizes are equal, which makes every
        // scale 1 and turns the magnifier into a no-op.
        this._iconSize = this._settings.get_int('icon-size');
        this._iconMax = this._settings.get_boolean('enable-magnification')
            ? Math.round(this._iconSize * Math.max(1, this._settings.get_double('max-scale')))
            : this._iconSize;
        this._restScale = this._iconSize / this._iconMax;

        for (const actor of [this._container, this._dock]) {
            for (const position of POSITIONS)
                actor.remove_style_class_name(position);
            actor.add_style_class_name(this._position);
        }
        this._dock.layout_manager.orientation = this._vertical
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
        this._applyStyle();

        this._magnifier.configure({
            vertical: this._vertical,
            restScale: this._restScale,
            range: this._iconMax * MAGNIFY_RANGE * this._themeContext.scale_factor,
            iconSize: this._iconSize * this._themeContext.scale_factor,
        });

        // A hidden dock is parked relative to its edge; start over shown.
        this._content.remove_all_transitions();
        this._content.set_translation(0, 0, 0);
        this._dockHidden = false;
        this._sliding = false;
        this._syncVisible();
        this._syncClip();

        this._syncItems(true);
    }

    _applyStyle() {
        const opacity = this._settings.get_double('dock-opacity');
        this._cornerRadius = this._settings.get_int('corner-radius');

        // The side facing the screen edge is tighter, because the running
        // dots already sit there; the two ends get a little extra.
        const far = this._settings.get_int('dock-padding');
        const ends = far + 2;
        const near = Math.max(far - 4, 0);
        let padding;
        switch (this._settings.get_string('position')) {
        case 'left':
            padding = [ends, far, ends, near];
            break;
        case 'right':
            padding = [ends, near, ends, far];
            break;
        default:
            padding = [far, ends, near, ends];
        }

        this._background.set_style(
            `background-color: rgba(22, 22, 26, ${opacity.toFixed(2)});` +
            `border-radius: ${this._cornerRadius}px;`);
        this._dock.set_style(
            `padding: ${padding.map(value => `${value}px`).join(' ')};` +
            `spacing: ${this._settings.get_int('icon-spacing')}px;`);
        this._syncBlur();
    }

    _applyBlur() {
        const monitorIndex = Main.layoutManager.primaryIndex;
        if (!this._settings.get_boolean('enable-blur') || monitorIndex < 0) {
            this._destroyBlur();
            return;
        }

        try {
            if (!this._blur) {
                this._blur = new BlurLayer(monitorIndex);
                this._blur.actor.connect('notify::allocation', () => this._syncBlur());
                this._backdrop.insert_child_below(this._blur.actor, this._background);
            }
            this._blur.setBlur(
                this._settings.get_int('blur-sigma') * this._themeContext.scale_factor,
                this._settings.get_double('blur-brightness'));
            this._syncBlur();
        } catch (e) {
            // Leave the dock merely translucent if this shell cannot do it.
            console.warn(`GlideDock: blur is unavailable: ${e.message}`);
            this._destroyBlur();
        }
    }

    _destroyBlur() {
        this._blur?.destroy();
        this._blur = null;
    }

    _syncBlur() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._blur || !monitor || !this._blur.actor.has_allocation())
            return;

        // The blur fills the content; measured there, because the backdrop
        // it is in may be stretched by the magnifier right now.
        const [x, y] = this._restingPosition(this._content);
        this._blur.sync(
            monitor.x - x,
            monitor.y - y,
            this._cornerRadius * this._themeContext.scale_factor);
    }

    // Where an actor inside the dock sits on screen when the dock is shown,
    // whatever the auto-hide slide is doing right now.
    _restingPosition(actor) {
        const [x, y] = actor.get_transformed_position();
        return [x - this._content.translation_x, y - this._content.translation_y];
    }

    // Items
    //
    // The model says which apps belong in the dock; this turns that into
    // actors. Icons that stay are kept as they are, so an app starting or
    // quitting never disturbs the one under the pointer.

    _wantedEntries() {
        const favorites = this._model.favorites;
        const running = this._model.getRunning(
            this._settings.get_string('running-apps-order'));
        const showApps = this._settings.get_boolean('show-apps-button');
        const showAppsAtStart = this._settings.get_boolean('show-apps-at-start');

        const entries = [];
        if (showApps && showAppsAtStart)
            entries.push({key: SHOW_APPS_KEY});
        for (const app of favorites)
            entries.push({key: app.get_id(), app});
        if (favorites.length > 0 && running.length > 0 &&
            this._settings.get_boolean('show-separator'))
            entries.push({key: SEPARATOR_KEY});
        for (const app of running)
            entries.push({key: app.get_id(), app});

        // Places follow the apps, the trash last. Show Apps stays at the
        // outer end of the dock, clear of the separator before the places.
        const places = [];
        if (this._downloads)
            places.push({key: DOWNLOADS_KEY});
        if (this._trash)
            places.push({key: TRASH_KEY});
        if (places.length > 0 && entries.length > 0 &&
            this._settings.get_boolean('show-places-separator'))
            entries.push({key: PLACES_SEPARATOR_KEY});
        entries.push(...places);
        if (showApps && !showAppsAtStart)
            entries.push({key: SHOW_APPS_KEY});
        return entries;
    }

    _syncItems(rebuild = false) {
        this._syncPlaces();
        const wanted = this._wantedEntries();
        const layoutKey = wanted.map(({key}) => key).join('\n');

        if (rebuild || layoutKey !== this._layoutKey) {
            this._layoutKey = layoutKey;

            const previous = new Map();
            if (rebuild) {
                this._hideLabel();
                this._dock.destroy_all_children();
            } else {
                for (const entry of this._entries)
                    previous.set(entry.key, entry);
            }

            this._entries = wanted.map(({key, app}) =>
                previous.get(key) ?? this._createEntry(key, app));
            this._entries.forEach(({actor}, index) => {
                if (actor.get_parent() === this._dock)
                    this._dock.set_child_at_index(actor, index);
                else
                    this._dock.insert_child_at_index(actor, index);
            });

            const kept = new Set(this._entries);
            for (const entry of previous.values()) {
                if (kept.has(entry))
                    continue;
                if (entry.item && entry.item === this._labelItem)
                    this._hideLabel();
                entry.actor.destroy();
            }

            this._items = this._entries.filter(({item}) => item).map(({item}) => item);
            this._magnifier.setItems(
                this._items,
                this._entries.filter(({item}) => !item).map(({actor}) => actor));
            this._reposition();
        }

        this._queueIconGeometry();

        const focusApp = this._model.focusApp;
        const showDots = this._settings.get_boolean('show-running-dots');
        for (const {app, dot} of this._items) {
            if (!app)
                continue;
            dot.opacity = showDots && this._model.isRunning(app) ? 255 : 0;
            if (app === focusApp)
                dot.add_style_class_name('focused');
            else
                dot.remove_style_class_name('focused');
        }
    }

    _createEntry(key, app) {
        if (key === SEPARATOR_KEY || key === PLACES_SEPARATOR_KEY)
            return {key, actor: new St.Widget({style_class: 'glidedock-separator'})};
        if (key === DOWNLOADS_KEY) {
            return this._createPlaceEntry(key, {
                name: _('Downloads'),
                iconName: 'folder-download',
                uri: this._downloads.uri,
                describeMenu: () => this._describeDownloadsMenu(),
                primary: item => this._toggleDownloadsStack(item),
            });
        }
        if (key === TRASH_KEY) {
            return this._createPlaceEntry(key, {
                name: _('Trash'),
                iconName: this._trash.iconName,
                uri: this._trash.uri,
                describeMenu: () => this._describeTrashMenu(),
            });
        }

        const item = key === SHOW_APPS_KEY
            ? this._createItem({
                app: null,
                name: _('Show Apps'),
                icon: this._showAppsIcon.create(this._iconMax),
                activate: () => this._toggleAppGrid(),
            })
            : this._createItem({
                app,
                name: app.get_name(),
                icon: app.create_icon_texture(this._iconMax),
                activate: mouseButton => {
                    if (mouseButton === Clutter.BUTTON_SECONDARY)
                        this._toggleAppMenu(item);
                    else
                        this._activateApp(app, mouseButton);
                },
                scroll: event => this._onScroll(app, event),
                secondary: true,
            });
        return {key, actor: item.button, item};
    }

    _createItem({app, name, icon, activate, scroll, secondary = false}) {
        const sf = this._themeContext.scale_factor;
        const size = this._iconSize * sf;
        const max = this._iconMax * sf;
        const dotSize = DOT_SIZE * sf;
        const gap = DOT_GAP * sf;

        // A slot is one *resting* icon long along the dock, and one resting
        // icon plus the running dot deep: the dock is as long as its icons
        // at rest, whatever the magnification. The icon's allocation is its
        // magnified size, centred on its resting place and scaled about that
        // centre, so it overflows the slot evenly when it grows; the
        // magnifier then pushes the slots around it apart to make room.
        const depth = size + gap + dotSize;
        const inset = Math.round((size - max) / 2);
        const dotCentered = Math.round((size - dotSize) / 2);
        let slotSize, iconPosition, dotPosition;
        switch (this._position) {
        case 'left':
            slotSize = [depth, size];
            iconPosition = [dotSize + gap + inset, inset];
            dotPosition = [0, dotCentered];
            break;
        case 'right':
            slotSize = [depth, size];
            iconPosition = [inset, inset];
            dotPosition = [size + gap, dotCentered];
            break;
        default:
            slotSize = [size, depth];
            iconPosition = [inset, inset];
            dotPosition = [dotCentered, size + gap];
        }

        // The icon is rendered at its magnified size and scaled *down* at
        // rest, so it stays sharp when magnified. Scaling and pushing are
        // paint-time transforms: no allocation ever changes, so the buttons,
        // the dock and the label anchor all stay put.
        icon.set_pivot_point(0.5, 0.5);
        icon.set_scale(this._restScale, this._restScale);
        icon.set_position(...iconPosition);

        const dot = new St.Widget({style_class: 'glidedock-dot', opacity: 0});
        dot.set_size(dotSize, dotSize);
        dot.set_position(...dotPosition);

        const slot = new St.Widget({layout_manager: new Clutter.FixedLayout()});
        slot.set_size(...slotSize);
        slot.add_child(dot);
        slot.add_child(icon);

        const button = new St.Button({
            style_class: 'glidedock-button',
            child: slot,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO |
                (secondary ? St.ButtonMask.THREE : 0),
            reactive: !this._inOverview || this._replacesDash,
            track_hover: true,
            can_focus: true,
            accessible_name: name,
        });

        const item = {app, name, button, slot, icon, dot, scale: this._restScale};
        button.connect('clicked', (_button, mouseButton) => activate(mouseButton));
        if (scroll)
            button.connect('scroll-event', (_button, event) => scroll(event));
        button.connect('notify::hover', () => {
            if (button.hover)
                this._showLabel(item);
            else if (this._labelItem === item)
                this._hideLabel();
        });
        return item;
    }

    _activateApp(app, mouseButton) {
        // From the overview a click always means "take me to this app".
        const inOverview = Main.overview.visible;
        const launching = app.state === Shell.AppState.STOPPED;

        // Middle click and Ctrl+click both ask for another window.
        const modifiers = Clutter.get_current_event()?.get_state() ?? 0;
        const newWindow = mouseButton === Clutter.BUTTON_MIDDLE ||
            (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
        activateApp(app, {
            newWindow,
            focused: !inOverview && this._model.focusApp === app,
            focusedAction: this._settings.get_string('click-action'),
        });
        if (inOverview)
            Main.overview.hide();
        if (launching)
            this._bounce(app);
    }

    // The icon of an app that is starting jumps away from the screen edge
    // until the app has a window to show for it. Some apps never report that
    // they have started, so any window that turns up after the launch ends
    // it as well; bounce.js adds a time limit for those that show nothing.
    _bounce(app) {
        const item = this._items.find(candidate => candidate.app === app);
        if (!item)
            return;

        const height = Math.round(this._iconSize * BOUNCE_HEIGHT) * this._themeContext.scale_factor;
        const offset = {left: [height, 0], right: [-height, 0]}[this._position] ?? [0, -height];
        const serial = this._windowSerial;
        bounceUntil(item.icon, offset, () =>
            app.state === Shell.AppState.RUNNING || this._windowSerial !== serial);
    }

    _toggleAppGrid() {
        if (!Main.overview.visible) {
            Main.overview.showApps();
            return;
        }

        // Already in the overview: do what the shell's own button does and
        // flip between the window picker and the app grid.
        const button = Main.overview.dash.showAppsButton;
        button.checked = !button.checked;
    }

    // Places
    //
    // The downloads folder and the trash are ordinary items as far as the
    // dock, the magnifier and the label are concerned. What sets them apart
    // is what a click does, and the menu behind the secondary button.

    _syncPlaces() {
        const showDownloads = this._settings.get_boolean('show-downloads');
        if (showDownloads && !this._downloads) {
            this._downloads = new Folder(downloadsFolder());
        } else if (!showDownloads && this._downloads) {
            this._downloads.destroy();
            this._downloads = null;
        }

        const showTrash = this._settings.get_boolean('show-trash');
        if (showTrash && !this._trash) {
            this._trash = new Trash(() => this._syncTrashIcon());
        } else if (!showTrash && this._trash) {
            this._trash.destroy();
            this._trash = null;
        }
    }

    _syncTrashIcon() {
        const entry = this._entries.find(({key}) => key === TRASH_KEY);
        if (entry)
            entry.item.icon.icon_name = this._trash.iconName;
    }

    // `primary`, if there is one, may take a click of the main button for
    // itself by returning true; otherwise the click opens the place.
    _createPlaceEntry(key, {name, iconName, uri, describeMenu, primary}) {
        const item = this._createItem({
            app: null,
            name,
            // The full-colour icon of the icon theme, at the size and in the
            // slot of an app icon, so that it sits among them as one of them.
            icon: new St.Icon({
                style_class: 'glidedock-place',
                icon_name: iconName,
                fallback_icon_name: `${iconName}-symbolic`,
                icon_size: this._iconMax,
            }),
            activate: mouseButton => {
                if (mouseButton === Clutter.BUTTON_SECONDARY)
                    this._togglePlaceMenu(item, describeMenu);
                else if (!primary?.(item))
                    this._openPlace(uri);
            },
            secondary: true,
        });
        return {key, actor: item.button, item};
    }

    _openPlace(uri) {
        openUri(uri);
        if (Main.overview.visible)
            Main.overview.hide();
    }

    // App menu
    //
    // The secondary button opens the menu the shell itself gives an app:
    // its windows, New Window and the app's own actions, Pin or Unpin, App
    // Details and Quit, each only when it applies. Open is added on top.

    _toggleAppMenu(item) {
        if (!item.menu) {
            const menu = new AppMenu(item.button, this._menuSide(), {
                favoritesSection: true,
                showSingleWindows: true,
            });
            menu.setApp(item.app);

            const open = new PopupMenu.PopupMenuItem(_('Open'));
            open.connect('activate', () => this._activateApp(item.app, Clutter.BUTTON_PRIMARY));
            menu.addMenuItem(open, 0);
            this._registerMenu(item, menu);
        }
        item.menu.toggle();
    }

    // The side of a menu its arrow is on: the one facing the dock.
    _menuSide() {
        return {left: St.Side.LEFT, right: St.Side.RIGHT}[this._position] ?? St.Side.BOTTOM;
    }

    _createPlaceMenu(item) {
        const menu = new PopupMenu.PopupMenu(item.button, 0.5, this._menuSide());
        this._registerMenu(item, menu);
        return menu;
    }

    // Puts a menu of an item on stage and ties it to the item's life.
    _registerMenu(item, menu) {
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);

        // An open menu keeps an auto-hiding dock on screen.
        const stateId = menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._openMenu = menu;
                this._hideLabel();
            } else if (this._openMenu === menu) {
                this._openMenu = null;
            }
            this._updateVisibility();
        });
        item.button.connect('destroy', () => {
            menu.disconnect(stateId);
            if (this._openMenu === menu)
                this._openMenu = null;
            item.menu = null;
            menu.destroy();
        });
        item.menu = menu;
    }

    // `describeMenu` returns the rows of the menu, or a promise of them: null
    // for a separator, otherwise {label, icon, sensitive, activate}.
    async _togglePlaceMenu(item, describeMenu) {
        const menu = item.menu ?? this._createPlaceMenu(item);
        if (menu.isOpen) {
            menu.close();
            return;
        }

        const rows = await describeMenu();
        // Reading a folder takes a moment; the item may be gone by now, or
        // the menu open already after a second click.
        if (item.menu !== menu || menu.isOpen)
            return;

        menu.removeAll();
        for (const row of rows) {
            if (!row) {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }
            const menuItem = row.icon
                ? new PopupMenu.PopupImageMenuItem(row.label, row.icon)
                : new PopupMenu.PopupMenuItem(row.label);
            menuItem.label.add_style_class_name('glidedock-menu-label');
            menuItem.setSensitive(row.sensitive ?? true);
            if (row.activate)
                menuItem.connect('activate', row.activate);
            menu.addMenuItem(menuItem);
        }
        menu.open();
    }

    // The files changed last, as rows for a menu or for a stack.
    async _describeDownloads() {
        const files = await this._downloads.listRecent(RECENT_FILES);
        return files.map(({name, icon, uri}) => ({
            label: name,
            icon,
            activate: () => this._openPlace(uri),
        }));
    }

    async _describeDownloadsMenu() {
        const folder = this._downloads;
        const rows = await this._describeDownloads();
        if (rows.length === 0)
            rows.push({label: _('No files'), sensitive: false});
        rows.push(null, {
            label: _('Open Downloads'),
            activate: () => this._openPlace(folder.uri),
        });
        return rows;
    }

    // Stacks
    //
    // With the fan view on, the main button fans the latest downloads out of
    // the icon instead of opening the folder; see stacks.js.

    _toggleDownloadsStack(item) {
        if (!this._settings.get_boolean('stacks-fan-view'))
            return false;
        if (this._stack)
            this._stack.close();
        else
            this._openDownloadsStack(item);
        return true;
    }

    async _openDownloadsStack(item) {
        const folder = this._downloads;
        const rows = await this._describeDownloads();
        // Reading the folder takes a moment; the item may be gone by now, or
        // a second click may have opened the stack already.
        if (this._stack || !this._items.includes(item))
            return;

        // The row furthest from the dock opens the folder itself.
        rows.push({
            label: _('Open in Files'),
            icon: Gio.ThemedIcon.new_from_names(['system-file-manager', 'folder']),
            activate: () => this._openPlace(folder.uri),
        });

        const [x, y] = this._restingPosition(item.button);
        const {width, height} = item.button;
        const stack = new FanStack({
            rows,
            sourceRect: {x, y, width, height},
            dockRect: this._dockRect,
            position: this._position,
            onClosed: () => {
                if (this._stack !== stack)
                    return;
                this._stack = null;
                this._updateVisibility();
            },
        });
        this._stack = stack;
        if (!stack.open())
            return;

        // An open stack keeps an auto-hiding dock on screen.
        this._hideLabel();
        this._magnifier.setPointer(null);
        this._updateVisibility();
    }

    _describeTrashMenu() {
        const trash = this._trash;
        return [{
            label: _('Open Trash'),
            activate: () => this._openPlace(trash.uri),
        }, {
            label: _('Empty Trash'),
            sensitive: trash.full,
            activate: () => this._confirmEmptyTrash(),
        }];
    }

    // Emptying cannot be undone, so it is never one click away.
    _confirmEmptyTrash() {
        if (this._emptyTrashDialog || !this._trash)
            return;

        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: _('Empty all items from Trash?'),
            description: _('All items in the Trash will be permanently deleted.'),
        }));
        dialog.addButton({
            label: _('Cancel'),
            action: () => dialog.close(),
            key: Clutter.KEY_Escape,
            default: true,
        });
        dialog.addButton({
            label: _('Empty Trash'),
            action: () => {
                dialog.close();
                this._trash?.empty();
            },
        });
        dialog.connect('destroy', () => {
            this._emptyTrashDialog = null;
        });
        this._emptyTrashDialog = dialog;
        dialog.open();
    }

    _onScroll(app, event) {
        if (!this._settings.get_boolean('scroll-to-switch'))
            return Clutter.EVENT_PROPAGATE;
        // Wheels report every notch twice; the smooth event is the real one.
        if (event.is_pointer_emulated())
            return Clutter.EVENT_STOP;

        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            this._scrollAccumulated += dx + dy;
            if (Math.abs(this._scrollAccumulated) >= 1) {
                step = Math.sign(this._scrollAccumulated);
                this._scrollAccumulated = 0;
            }
            break;
        }
        }

        // Touchpads produce a stream of deltas; switch at a readable pace.
        const time = event.get_time();
        if (step !== 0 && time - this._scrollTime >= SCROLL_INTERVAL) {
            this._scrollTime = time;
            cycleWindows(app, step);
        }
        return Clutter.EVENT_STOP;
    }

    // Placement

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const sf = this._themeContext.scale_factor;
        const [, width] = this._container.get_preferred_width(-1);
        const [, height] = this._container.get_preferred_height(-1);
        const margin = EDGE_MARGIN * sf;

        // Places a span of the given length inside [from, from + available].
        const align = (from, available, length) => {
            switch (this._settings.get_string('alignment')) {
            case 'start':
                return from + margin;
            case 'end':
                return from + available - length - margin;
            default:
                return Math.round(from + (available - length) / 2);
            }
        };

        let x, y;
        if (this._vertical) {
            // Stay clear of the top panel.
            const top = Main.layoutManager.panelBox.height;
            x = this._position === 'left'
                ? monitor.x
                : monitor.x + monitor.width - width;
            y = align(monitor.y + top, monitor.height - top, height);
        } else {
            x = align(monitor.x, monitor.width, width);
            y = monitor.y + monitor.height - height;
        }
        this._container.set_position(x, y);
        this._queueIconGeometry();
        this._dockRect = {x, y, width, height};
        this._overlap?.setRect(this._dockRect);
        this._syncDashSpace();

        // The reveal strip hugs the screen edge along the dock's length.
        const edge = EDGE_SIZE * sf;
        if (this._position === 'left') {
            this._edge.set_position(monitor.x, y);
            this._edge.set_size(edge, height);
        } else if (this._position === 'right') {
            this._edge.set_position(monitor.x + monitor.width - edge, y);
            this._edge.set_size(edge, height);
        } else {
            this._edge.set_position(x, monitor.y + monitor.height - edge);
            this._edge.set_size(width, edge);
        }
    }

    // Minimize target
    //
    // The shell animates a window that is minimized towards its "icon
    // geometry", and towards the middle of the screen edge if it has none.
    // Every window is told where the icon of its app rests in the dock: a
    // fixed place, whatever magnification and the auto-hide slide are doing,
    // so there is nothing to follow while the pointer moves.

    // Windows, icons and the dock tend to change together; one pass after
    // the dust has settled covers them all.
    _queueIconGeometry() {
        if (this._geometryIdleId)
            return;
        this._geometryIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._geometryIdleId = 0;
            this._syncIconGeometry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncIconGeometry() {
        const size = this._iconSize * this._themeContext.scale_factor;
        for (const {app, button, icon} of this._items) {
            if (!app || !button.has_allocation())
                continue;

            // The icon's allocation is its magnified size; at rest it is
            // drawn smaller around the same centre.
            const [x, y] = this._restingPosition(button);
            for (const window of app.get_windows()) {
                // A rectangle of whatever type this shell uses for them.
                const rect = window.get_frame_rect();
                rect.x = Math.round(x + icon.x + (icon.width - size) / 2);
                rect.y = Math.round(y + icon.y + (icon.height - size) / 2);
                rect.width = size;
                rect.height = size;
                window.set_icon_geometry(rect);
            }
        }
    }

    // Back to the shell's default for every window, ours or not.
    _clearIconGeometry() {
        for (const actor of global.get_window_actors())
            actor.meta_window?.set_icon_geometry(null);
    }

    // Label

    _showLabel(item) {
        const sf = this._themeContext.scale_factor;
        const label = this._label;
        label.text = item.name;

        const [buttonX, buttonY] = this._restingPosition(item.button);
        const {width: buttonWidth, height: buttonHeight} = item.button;
        const [, width] = label.get_preferred_width(-1);
        const [, height] = label.get_preferred_height(-1);

        // Fixed distance from the icon's *fully magnified* far edge, so the
        // label never has to follow the animation.
        const clearance = (Math.ceil((this._iconMax - this._iconSize) / 2) + LABEL_GAP) * sf;
        let x, y;
        switch (this._position) {
        case 'left':
            x = buttonX + buttonWidth + clearance;
            y = buttonY + buttonHeight / 2 - height / 2;
            break;
        case 'right':
            x = buttonX - clearance - width;
            y = buttonY + buttonHeight / 2 - height / 2;
            break;
        default:
            x = buttonX + buttonWidth / 2 - width / 2;
            y = buttonY - clearance - height;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - width));
            y = Math.max(monitor.y, Math.min(y, monitor.y + monitor.height - height));
        }

        // Whole pixels only, or the text shimmers.
        label.set_position(Math.round(x), Math.round(y));
        label.show();
        this._labelItem = item;
    }

    _hideLabel() {
        this._label.hide();
        this._labelItem = null;
    }

    // Auto-hide
    //
    // With intellihide on, the dock stops reserving screen space and slides
    // off its edge while a window overlaps where it would be. The pointer
    // brings it back by touching the screen edge.

    _applyIntellihide() {
        const enabled = this._settings.get_boolean('intellihide');
        if (this._chromeAdded && enabled === this._intellihide)
            return;
        this._intellihide = enabled;

        // Only a dock that is always there may reserve space, and that can
        // only be chosen when the actor is added.
        if (this._chromeAdded)
            Main.layoutManager.removeChrome(this._container);
        Main.layoutManager.addChrome(this._container, {affectsStruts: !enabled});
        this._chromeAdded = true;
        Main.layoutManager.uiGroup.set_child_above_sibling(this._label, null);

        this._overlap?.destroy();
        this._overlap = enabled
            ? new OverlapTracker(() => this._updateVisibility())
            : null;
        this._overlap?.setRect(this._dockRect);

        this._syncClip();
        this._updateVisibility();
    }

    _wantHidden() {
        return !!this._overlap?.overlapped && !this._inOverview &&
            !this._revealed && !this._container.hover && !this._openMenu && !this._stack;
    }

    _updateVisibility() {
        if (!this._wantHidden()) {
            this._clearTimer('_hideTimerId');
            this._setDockHidden(false);
        } else if (!this._dockHidden && !this._hideTimerId) {
            this._hideTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, this._settings.get_int('hide-delay'), () => {
                    this._hideTimerId = 0;
                    if (this._wantHidden())
                        this._setDockHidden(true);
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _setDockHidden(hidden) {
        if (this._dockHidden === hidden)
            return;
        this._dockHidden = hidden;

        let x = 0, y = 0;
        if (hidden) {
            this._hideLabel();
            this._magnifier.setPointer(null);
            if (this._position === 'left')
                x = -this._container.width;
            else if (this._position === 'right')
                x = this._container.width;
            else
                y = this._container.height;
        }

        // One paint-time translation; nothing is relaid out while sliding.
        // The container stays visible until the slide out has finished.
        const slideId = ++this._slideId;
        this._sliding = true;
        this._syncVisible();
        this._content.ease({
            translation_x: x,
            translation_y: y,
            duration: SLIDE_TIME,
            mode: hidden
                ? Clutter.AnimationMode.EASE_IN_QUAD
                : Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                // A newer slide has taken over; it will finish the job.
                if (slideId !== this._slideId)
                    return;
                this._sliding = false;
                this._syncVisible();
            },
        });
    }

    // The pointer reached the screen edge over a hidden dock.
    _onEdgeEntered() {
        this._clearTimer('_showTimerId');
        this._showTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, this._settings.get_int('show-delay'), () => {
                this._showTimerId = 0;
                this._revealed = true;
                this._updateVisibility();

                // From here on hovering keeps the dock up; if the pointer
                // never arrives, let it go again.
                this._clearTimer('_revealTimerId');
                this._revealTimerId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, REVEAL_GRACE, () => {
                        this._revealTimerId = 0;
                        this._revealed = false;
                        this._updateVisibility();
                        return GLib.SOURCE_REMOVE;
                    });
                return GLib.SOURCE_REMOVE;
            });
    }

    // A sliding dock must not show up on the neighbouring monitor, so it is
    // clipped on the side of its screen edge only; magnified icons may still
    // overflow in every other direction.
    _syncClip() {
        if (!this._intellihide) {
            this._container.remove_clip();
            return;
        }
        const {width, height} = this._container;
        if (this._position === 'left')
            this._container.set_clip(0, -FAR, width + FAR, height + 2 * FAR);
        else if (this._position === 'right')
            this._container.set_clip(-FAR, -FAR, width + FAR, height + 2 * FAR);
        else
            this._container.set_clip(-FAR, -FAR, width + 2 * FAR, height + FAR);
    }

    // Visibility
    //
    // Three things can take the dock off screen: a fullscreen window, the
    // auto-hide slide, and, unless the dock replaces the shell's dash, the
    // overview. The first two hide the container; the overview only fades it,
    // so that the space a non-hiding dock reserves does not change.

    _isFullscreen() {
        // Windows are not shown in the overview, fullscreen or not.
        const monitorIndex = Main.layoutManager.primaryIndex;
        if (this._inOverview || monitorIndex < 0)
            return false;
        if (global.display.get_monitor_in_fullscreen(monitorIndex))
            return true;

        // The shell stops counting a monitor as fullscreen as soon as any
        // other window is stacked above the fullscreen one. The dock has no
        // business there for as long as that window is the one being used.
        const focus = global.display.focus_window;
        return !!focus && focus.is_fullscreen() && focus.get_monitor() === monitorIndex;
    }

    _syncVisible() {
        const fullscreen = this._isFullscreen();
        this._container.visible = !fullscreen && (!this._dockHidden || this._sliding);
        this._edge.visible = this._dockHidden && !this._sliding &&
            !fullscreen && !this._inOverview;
        if (!this._container.visible) {
            this._hideLabel();
            this._openMenu?.close();
            this._stack?.close();
        }
    }

    _setInOverview(inOverview) {
        // The overview announces itself again when it is reopened half way
        // through closing; restarting the fade then would make it stutter.
        if (inOverview === this._inOverview)
            return;
        this._inOverview = inOverview;
        this._syncOverview(true);
        this._syncVisible();
        this._updateVisibility();
    }

    // Whether the overview fades the dock away, or leaves it alone.
    _syncOverview(animate) {
        const faded = this._inOverview && !this._replacesDash;

        this._container.reactive = !faded;
        for (const {button} of this._items)
            button.reactive = !faded;
        if (faded) {
            this._hideLabel();
            this._openMenu?.close();
            this._stack?.close();
            this._magnifier.setPointer(null);
        }
        this._container.ease({
            opacity: faded ? 0 : 255,
            duration: animate ? FADE_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Overview
    //
    // The overview has a dash of its own in the same place. Either the dock
    // steps aside for it (above), or it takes its place: the shell's dash is
    // hidden and this dock simply stays where it is, so that the bar looks the
    // same on the desktop and in the overview and nothing changes in between.

    _applyOverviewMode() {
        this._setReplacesDash(this._settings.get_boolean('show-in-overview'));
        this._syncOverview(false);
    }

    _setReplacesDash(replaces) {
        if (replaces === this._replacesDash)
            return;
        this._replacesDash = replaces;

        // Gone already when the shell itself is shutting down.
        const dash = Main.overview.dash;
        if (!dash)
            return;

        if (replaces) {
            dash.hide();
        } else {
            // Exactly as the shell had it: shown, at its natural size.
            dash.set_height(-1);
            dash.show();
        }
        this._syncDashSpace();
    }

    // The overview lays itself out around its dash even while that is hidden.
    // Giving the hidden dash this dock's footprint keeps windows and the app
    // grid clear of a bottom dock, and frees the space for a side dock.
    _syncDashSpace() {
        if (!this._replacesDash)
            return;
        Main.overview.dash?.set_height(
            this._vertical || !this._dockRect ? 0 : this._dockRect.height);
    }
}
