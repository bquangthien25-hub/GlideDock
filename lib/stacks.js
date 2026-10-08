// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// All sizes are in logical pixels; they are multiplied by the St scale factor.
const ICON_SIZE = 48;
const ITEM_GAP = 6;       // space between two items of the fan
const DOCK_GAP = 12;      // space between the dock and the item nearest to it
const CURVE = 0.8;        // sideways drift of an item: CURVE * (its index)²
const START_SCALE = 0.2;  // size of an item while it is still inside the dock icon

const OPEN_TIME = 240;    // ms; one item flying out
const CLOSE_TIME = 160;   // ms; one item flying back
const STAGGER = 22;       // ms between two items setting off

/**
 * A stack fanned out of a dock icon: a column of rows that rises from the
 * icon and leans away as it goes, like the fan of a macOS dock.
 *
 * Every row is laid out once, at the place where it ends up. Opening and
 * closing only animate its translation, scale, rotation and opacity, which
 * are paint-time transforms: nothing is allocated again while the fan moves.
 */
export class FanStack {
    /**
     * @param {object} params
     * @param {{label: string, icon: Gio.Icon, activate: Function}[]} params.rows -
     *     nearest the dock first; the last one is kept when not all of them fit
     * @param {{x: number, y: number, width: number, height: number}} params.sourceRect -
     *     the dock icon the fan comes out of
     * @param {{x: number, y: number, width: number, height: number}} params.dockRect
     * @param {string} params.position - 'bottom', 'left' or 'right': the screen edge of the dock
     * @param {Function} params.onClosed - called once the fan is gone
     */
    constructor({rows, sourceRect, dockRect, position, onClosed}) {
        this._onClosed = onClosed;
        this._grab = null;
        this._closing = false;

        // Covers the screen: a click anywhere outside the rows lands here.
        this._layer = new St.Widget({reactive: true});
        this._layer.set_size(global.stage.width, global.stage.height);
        this._layer.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._layer.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        Main.layoutManager.uiGroup.add_child(this._layer);

        this._items = this._layOut(rows, sourceRect, dockRect, position);
    }

    // Places every row where it rests when the fan is open, and leaves it
    // folded into the dock icon.
    _layOut(rows, sourceRect, dockRect, position) {
        const sf = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitor = Main.layoutManager.primaryMonitor;
        const iconSize = ICON_SIZE * sf;
        const sourceX = sourceRect.x + sourceRect.width / 2;
        const sourceY = sourceRect.y + sourceRect.height / 2;

        // Centre of the icon of the row nearest the dock, and the way the
        // column leans: +1 to the right, -1 to the left.
        let baseX, baseY, lean;
        if (position === 'left') {
            baseX = dockRect.x + dockRect.width + DOCK_GAP * sf + iconSize / 2;
            baseY = sourceY;
            lean = 1;
        } else if (position === 'right') {
            baseX = dockRect.x - DOCK_GAP * sf - iconSize / 2;
            baseY = sourceY;
            lean = -1;
        } else {
            baseX = sourceX;
            baseY = dockRect.y - DOCK_GAP * sf - iconSize / 2;
            lean = 1;
        }

        const step = iconSize + ITEM_GAP * sf;
        const top = monitor.y + Main.layoutManager.panelBox.height;
        const fitting = Math.max(1, Math.floor((baseY + iconSize / 2 - top) / step));
        if (rows.length > fitting)
            rows = [...rows.slice(0, fitting - 1), rows.at(-1)];

        const drift = index => CURVE * sf * index * index;
        // Above a bottom dock the fan leans right unless it would leave the screen.
        if (position === 'bottom' &&
            baseX + drift(rows.length - 1) + iconSize / 2 > monitor.x + monitor.width)
            lean = -1;
        // Names go on the side the fan leans away from; next to a dock on a
        // side edge that is where the dock is, so they go on the other side.
        const labelFirst = position === 'bottom' ? lean > 0 : position === 'right';

        return rows.map((row, index) => {
            const button = this._createRow(row, labelFirst);
            this._layer.add_child(button);

            const [, , width, height] = button.get_preferred_size();
            const iconOffset = labelFirst ? width - iconSize / 2 : iconSize / 2;
            const x = baseX + lean * drift(index);
            const y = baseY - index * step;
            button.set_position(Math.round(x - iconOffset), Math.round(y - height / 2));
            button.set_pivot_point(iconOffset / width, 0.5);

            const folded = {
                translation_x: sourceX - x,
                translation_y: sourceY - y,
                scale_x: START_SCALE,
                scale_y: START_SCALE,
                rotation_angle_z: 0,
                opacity: 0,
            };
            button.set(folded);
            // Each row follows the slope of the curve where it sits.
            const angle = lean * Math.atan2(2 * CURVE * sf * index, step) * 180 / Math.PI;
            return {button, folded, angle};
        });
    }

    // The icon touches the outer edge of its row: the stylesheet must not
    // put padding around it, or the fan would not line up with the dock icon.
    _createRow(row, labelFirst) {
        const label = new St.Label({
            style_class: 'glidedock-stack-label',
            text: row.label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = new St.Icon({gicon: row.icon, icon_size: ICON_SIZE});

        const box = new St.BoxLayout({style_class: 'glidedock-stack-row'});
        box.add_child(labelFirst ? label : icon);
        box.add_child(labelFirst ? icon : label);

        const button = new St.Button({
            style_class: 'glidedock-stack-button',
            child: box,
            can_focus: true,
            track_hover: true,
            accessible_name: row.label,
        });
        button.connect('clicked', () => {
            this.close();
            row.activate();
        });
        return button;
    }

    /**
     * Fans the rows out. Until it is closed the fan has the pointer and the
     * keyboard to itself.
     *
     * @returns {boolean} false if the shell would not let it: the fan is gone then
     */
    open() {
        const grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
        // Before GNOME 50 a grab could be refused, and said so.
        if (grab.get_seat_state && grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            this.destroy();
            return false;
        }
        this._grab = grab;
        this._layer.grab_key_focus();

        this._items.forEach(({button, angle}, index) => {
            button.ease({
                translation_x: 0,
                translation_y: 0,
                scale_x: 1,
                scale_y: 1,
                rotation_angle_z: angle,
                opacity: 255,
                delay: index * STAGGER,
                duration: OPEN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
        return true;
    }

    /** Folds the rows back into the dock icon, then destroys the fan. */
    close() {
        if (this._closing || !this._layer)
            return;
        this._closing = true;
        this._ungrab();
        this._layer.reactive = false;

        // The row furthest out leaves first; the nearest one is the last to land.
        const last = this._items.length - 1;
        this._items.forEach(({button, folded}, index) => {
            button.reactive = false;
            button.ease({
                ...folded,
                delay: (last - index) * STAGGER / 2,
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: index === 0 ? () => this.destroy() : undefined,
            });
        });
    }

    /** Removes the fan at once, without animation. */
    destroy() {
        if (!this._layer)
            return;
        this._ungrab();
        const layer = this._layer;
        this._layer = null;
        this._items = [];
        layer.destroy();

        const onClosed = this._onClosed;
        this._onClosed = null;
        onClosed?.();
    }

    _ungrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onKeyPress(event) {
        const buttons = this._items.map(({button}) => button);
        const focused = buttons.indexOf(global.stage.get_key_focus());
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        // Up is away from the dock, like the rows themselves.
        case Clutter.KEY_Up:
            buttons[Math.min(focused + 1, buttons.length - 1)].grab_key_focus();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            buttons[Math.max(focused - 1, 0)].grab_key_focus();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
