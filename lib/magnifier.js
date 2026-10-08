// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// ms; time constant of the damping that makes icons follow their target scale
const TAU = 45;

/**
 * Scales dock icons around the pointer.
 *
 * Pointer events only record a coordinate. All work happens in one
 * frame-synced callback that runs while something is still moving, and the
 * only thing it touches is each icon's scale: a paint-time transform that
 * never causes a relayout.
 *
 * Items are `{button, icon, scale}`: `button` is the fixed slot whose centre
 * is measured, `icon` the actor that is scaled, `scale` its current scale.
 */
export class Magnifier {
    /** @param {Clutter.Actor} actor - any actor on the stage the dock is on */
    constructor(actor) {
        this._items = [];
        this._centers = null;
        this._pointer = null;
        this._vertical = false;
        this._restScale = 1;
        this._range = 0;

        this._ticker = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._ticker.connect('new-frame', () => this._tick());
    }

    destroy() {
        this._ticker.stop();
        this._ticker = null;
        this._items = [];
    }

    /**
     * @param {object} params
     * @param {boolean} params.vertical - whether the dock runs top to bottom
     * @param {number} params.restScale - icon scale away from the pointer; 1 disables magnification
     * @param {number} params.range - pointer distance, in pixels, at which the effect fades to nothing
     */
    configure({vertical, restScale, range}) {
        this._vertical = vertical;
        this._restScale = restScale;
        this._range = range;
        this.invalidate();
    }

    setItems(items) {
        this._items = items;
        this.invalidate();
        this._start();
    }

    /** Forget cached geometry; call whenever the dock is laid out again. */
    invalidate() {
        this._centers = null;
    }

    /** @param {number?} coordinate - along the dock's axis; null when the pointer left */
    setPointer(coordinate) {
        this._pointer = coordinate;
        this._start();
    }

    _start() {
        if (this._ticker && !this._ticker.is_playing())
            this._ticker.start();
    }

    // Centres of the buttons along the dock axis. Buttons are never
    // transformed, so these only change on relayout and are cached until then.
    _getCenters() {
        if (!this._centers) {
            if (this._items.some(({button}) => !button.has_allocation()))
                return null;
            this._centers = this._items.map(({button}) => {
                const [x, y] = button.get_transformed_position();
                return this._vertical ? y + button.height / 2 : x + button.width / 2;
            });
        }
        return this._centers;
    }

    _tick() {
        const rest = this._restScale;
        const centers = this._pointer === null || rest === 1 ? null : this._getCenters();

        // Exponential damping: each frame covers a fixed fraction of the
        // remaining distance, scaled by the real frame time so the motion is
        // the same at 60 and 144 Hz and has no start-up delay.
        const elapsed = Math.min(this._ticker.get_delta() || 16, 50);
        const blend = St.Settings.get().enable_animations
            ? 1 - Math.exp(-elapsed / TAU)
            : 1;

        let settled = true;
        for (let i = 0; i < this._items.length; i++) {
            const item = this._items[i];

            // Raised cosine falloff: smooth at the peak and at the edge of
            // the range, so icons rise and sink like a wave under the pointer.
            let target = rest;
            if (centers) {
                const distance = Math.abs(this._pointer - centers[i]);
                if (distance < this._range) {
                    target += (1 - rest) *
                        Math.cos(distance / this._range * Math.PI / 2) ** 2;
                }
            }

            let scale = item.scale + (target - item.scale) * blend;
            if (Math.abs(target - scale) < 0.002)
                scale = target;
            else
                settled = false;

            if (scale !== item.scale) {
                item.scale = scale;
                item.icon.set_scale(scale, scale);
            }
        }

        // Nothing left to animate: stop until something changes again.
        if (settled)
            this._ticker.stop();
    }
}
