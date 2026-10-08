// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {activateApp, cycleWindows} from './appActions.js';
import {AppModel} from './appModel.js';
import {BlurLayer} from './blur.js';
import {Magnifier} from './magnifier.js';
import {OverlapTracker} from './overlap.js';

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

// Settings that only restyle the dock, only change which icons it holds, or
// are simply read when needed. Any key in none of these sets changes the
// geometry of the icons and rebuilds them.
const STYLE_KEYS = new Set(['dock-opacity', 'corner-radius', 'icon-spacing', 'dock-padding']);
const ITEM_KEYS = new Set([
    'show-apps-button', 'show-apps-at-start', 'show-separator',
    'show-running-dots', 'running-apps-order',
]);
const BLUR_KEYS = new Set(['enable-blur', 'blur-sigma', 'blur-brightness']);
const LIVE_KEYS = new Set(['hide-delay', 'show-delay', 'click-action', 'scroll-to-switch']);

/**
 * The dock on screen: its actors, where they sit, and how they react.
 *
 * Actor tree:
 *
 *   container   fixed footprint on screen, tracked by the layout manager
 *   └ content   the only thing that moves when the dock auto-hides
 *     ├ blur    optional, see blur.js
 *     └ dock    the visible bar; one fixed-size button per icon
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

        // The dock ships its own Show Apps icon. Looking 'view-app-grid' up
        // in the icon theme gives a different picture depending on the theme
        // and on the size asked for, so the button would change with both.
        this._showAppsIcon = new Gio.FileIcon({
            file: extensionDir.get_child('icons').get_child('glidedock-show-apps-symbolic.svg'),
        });
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

        this._createActors();
        this._magnifier = new Magnifier(this._container);
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
        this._connect(global.display, 'in-fullscreen-changed', () => this._syncVisible());

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
        this._dock = null;

        this._label.destroy();
        this._label = null;
    }

    // Everything that is not an actor of ours is released here. It also runs
    // when the shell tears the stage down without disabling the extension
    // first, so that nothing calls back into disposed actors.
    _onDestroy() {
        for (const timer of ['_hideTimerId', '_showTimerId', '_revealTimerId'])
            this._clearTimer(timer);
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];

        this._magnifier.destroy();
        this._magnifier = null;
        this._model.destroy();
        this._model = null;
        this._overlap?.destroy();
        this._overlap = null;
        this._destroyBlur();
        this._setReplacesDash(false);

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
        this._content = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
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
        this._dock.connect('notify::allocation', () => this._magnifier.invalidate());
        this._container.connect('destroy', () => this._onDestroy());

        // The one and only label. It lives on uiGroup, outside the dock's
        // actor tree, so nothing that scales or relayouts can ever move it.
        this._label = new St.Label({style_class: 'glidedock-label', visible: false});
        Main.layoutManager.uiGroup.add_child(this._label);

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

        this._dock.set_style(
            `background-color: rgba(22, 22, 26, ${opacity.toFixed(2)});` +
            `border-radius: ${this._cornerRadius}px;` +
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
                this._content.insert_child_below(this._blur.actor, this._dock);
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

        const [x, y] = this._restingPosition(this._blur.actor);
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
        if (showApps && !showAppsAtStart)
            entries.push({key: SHOW_APPS_KEY});
        return entries;
    }

    _syncItems(rebuild = false) {
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
            this._magnifier.setItems(this._items);
            this._reposition();
        }

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
        if (key === SEPARATOR_KEY)
            return {key, actor: new St.Widget({style_class: 'glidedock-separator'})};

        const item = key === SHOW_APPS_KEY
            ? this._createItem({
                app: null,
                name: _('Show Apps'),
                icon: new St.Icon({
                    style_class: 'glidedock-show-apps',
                    gicon: this._showAppsIcon,
                    icon_size: this._iconMax,
                }),
                activate: () => this._toggleAppGrid(),
            })
            : this._createItem({
                app,
                name: app.get_name(),
                icon: app.create_icon_texture(this._iconMax),
                activate: mouseButton => this._activateApp(app, mouseButton),
                scroll: event => this._onScroll(app, event),
            });
        return {key, actor: item.button, item};
    }

    _createItem({app, name, icon, activate, scroll}) {
        const sf = this._themeContext.scale_factor;
        const size = this._iconSize * sf;
        const max = this._iconMax * sf;
        const dotSize = DOT_SIZE * sf;
        const gap = DOT_GAP * sf;

        // A slot is one magnified icon long along the dock, and one resting
        // icon plus the running dot deep. The icon's allocation is centred on
        // its resting place and scaled about that centre, so it grows evenly
        // and overflows the slot on both sides.
        const depth = size + gap + dotSize;
        const inset = Math.round((size - max) / 2);
        const dotCentered = Math.round((max - dotSize) / 2);
        let slotSize, iconPosition, dotPosition;
        switch (this._position) {
        case 'left':
            slotSize = [depth, max];
            iconPosition = [dotSize + gap + inset, 0];
            dotPosition = [0, dotCentered];
            break;
        case 'right':
            slotSize = [depth, max];
            iconPosition = [inset, 0];
            dotPosition = [size + gap, dotCentered];
            break;
        default:
            slotSize = [max, depth];
            iconPosition = [0, inset];
            dotPosition = [dotCentered, size + gap];
        }

        // The icon is rendered at its magnified size and scaled *down* at
        // rest, so it stays sharp when magnified. Scaling is a paint-time
        // transform: the slot's allocation never changes, so neighbouring
        // icons, the dock and the label anchor all stay put.
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
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            reactive: !this._inOverview || this._replacesDash,
            track_hover: true,
            can_focus: true,
            accessible_name: name,
        });

        const item = {app, name, button, icon, dot, scale: this._restScale};
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
        activateApp(app, {
            mouseButton,
            focused: !inOverview && this._model.focusApp === app,
            focusedAction: this._settings.get_string('click-action'),
        });
        if (inOverview)
            Main.overview.hide();
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
            !this._revealed && !this._container.hover;
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
        return !this._inOverview && monitorIndex >= 0 &&
            global.display.get_monitor_in_fullscreen(monitorIndex);
    }

    _syncVisible() {
        const fullscreen = this._isFullscreen();
        this._container.visible = !fullscreen && (!this._dockHidden || this._sliding);
        this._edge.visible = this._dockHidden && !this._sliding &&
            !fullscreen && !this._inOverview;
        if (!this._container.visible)
            this._hideLabel();
    }

    _setInOverview(inOverview) {
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
