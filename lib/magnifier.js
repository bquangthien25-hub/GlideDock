// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

// ms; time constant of the damping that makes icons follow their target scale
const TAU = 45;

/**
 * Scales dock icons around the pointer, and makes room for them.
 *
 * At rest every icon has a slot of its own size and the dock is exactly as
 * long as its icons. An icon that grows needs more than its slot, so the
 * icons around it are pushed apart by what it gained, and the backdrop is
 * stretched to keep them all inside. The point under the pointer stays where
 * it is: icons before it move one way, icons after it the other.
 *
 * Pointer events only record a coordinate. All work happens in one
 * frame-synced callback that runs while something is still moving, and it
 * only ever touches scales and translations: paint-time transforms that
 * never cause a relayout. The buttons that take the clicks do not move.
 *
 * Items are `{button, slot, icon, scale}`: `button` is the fixed hit area
 * that is measured, `slot` the actor inside it that is pushed along the
 * dock, `icon` the actor that is scaled, `scale` its current scale.
 */
export class Magnifier {
    /** @param {Clutter.Actor} actor - any actor on the stage the dock is on */
    constructor(actor) {
        this._items = [];
        this._followers = [];
        this._backdrop = null;
        this._geometry = null;
        this._pointer = null;
        this._anchor = 0;
        this._vertical = false;
        this._restScale = 1;
        this._range = 0;
        this._iconSize = 0;

        this._ticker = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._ticker.connect('new-frame', () => this._tick());
    }

    destroy() {
        this._ticker.stop();
        this._ticker = null;
        this._items = [];
        this._followers = [];
        this._backdrop = null;
    }

    /**
     * @param {object} params
     * @param {boolean} params.vertical - whether the dock runs top to bottom
     * @param {number} params.restScale - icon scale away from the pointer; 1 disables magnification
     * @param {number} params.range - pointer distance, in pixels, at which the effect fades to nothing
     * @param {number} params.iconSize - length of an icon at rest along the dock, in pixels
     */
    configure({vertical, restScale, range, iconSize}) {
        this._vertical = vertical;
        this._restScale = restScale;
        this._range = range;
        this._iconSize = iconSize;
        this._resetBackdrop();
        this.invalidate();
    }

    /**
     * @param {Clutter.Actor} backdrop - what is drawn behind the icons; it is
     *     stretched along the dock, from its start, to stay behind all of them
     */
    setBackdrop(backdrop) {
        this._backdrop = backdrop;
        this._resetBackdrop();
    }

    /**
     * @param {object[]} items - see the class description
     * @param {Clutter.Actor[]} followers - other actors in the dock, such as
     *     separators, that are pushed along with the icons around them
     */
    setItems(items, followers = []) {
        this._items = items;
        this._followers = followers;
        this.invalidate();
        this._start();
    }

    /** Forget cached geometry; call whenever the dock is laid out again. */
    invalidate() {
        this._geometry = null;
    }

    /** @param {number?} coordinate - along the dock's axis; null when the pointer left */
    setPointer(coordinate) {
        this._pointer = coordinate;
        // The spread stays centred on where the pointer was while it fades.
        if (coordinate !== null)
            this._anchor = coordinate;
        this._start();
    }

    _start() {
        if (this._ticker && !this._ticker.is_playing())
            this._ticker.start();
    }

    _resetBackdrop() {
        if (!this._backdrop)
            return;
        this._backdrop.set_pivot_point(this._vertical ? 0.5 : 0, this._vertical ? 0 : 0.5);
        this._backdrop.set_scale(1, 1);
        this._backdrop.set_translation(0, 0, 0);
    }

    _along(actor) {
        const [x, y] = actor.get_transformed_position();
        return this._vertical ? [y, actor.height] : [x, actor.width];
    }

    // Where everything rests along the dock axis. Buttons and followers are
    // never transformed, so this only changes on relayout and is cached.
    _getGeometry() {
        if (!this._geometry) {
            const measured = [...this._items.map(({button}) => button), ...this._followers];
            if (measured.some(actor => !actor.has_allocation()) ||
                !this._backdrop?.has_allocation())
                return null;

            this._geometry = {
                spans: this._items.map(({button}) => {
                    const [start, length] = this._along(button);
                    return {start, length, center: start + length / 2};
                }),
                followers: this._followers.map(actor => {
                    const [start, length] = this._along(actor);
                    return start + length / 2;
                }),
                length: this._vertical ? this._backdrop.height : this._backdrop.width,
            };
        }
        return this._geometry;
    }

    _translate(actor, offset) {
        if (this._vertical)
            actor.translation_y = offset;
        else
            actor.translation_x = offset;
    }

    _tick() {
        const rest = this._restScale;
        const geometry = this._getGeometry();
        const pointing = this._pointer !== null && rest !== 1 && geometry !== null;

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
            if (pointing) {
                const distance = Math.abs(this._pointer - geometry.spans[i].center);
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

        if (geometry)
            this._spread(geometry);

        // Nothing left to animate: stop until something changes again.
        if (settled)
            this._ticker.stop();
    }

    // Pushes everything apart by what the icons have grown. Follows from the
    // scales alone, so it is as smooth as they are and gone when they are.
    _spread({spans, followers, length}) {
        // How much longer than at rest each icon is right now.
        const gains = this._items.map(({scale}) =>
            (scale / this._restScale - 1) * this._iconSize);

        // The length gained before a point of the resting dock: icons wholly
        // before it count in full, the one it is in counts in proportion.
        const gainedBefore = position => {
            let sum = 0;
            for (let i = 0; i < spans.length; i++) {
                const {start, length: span} = spans[i];
                if (position >= start + span)
                    sum += gains[i];
                else if (position > start)
                    sum += gains[i] * (position - start) / span;
            }
            return sum;
        };

        // Whatever was gained before the pointer is taken off everything, so
        // that the pointer and what is under it do not move.
        const anchored = gainedBefore(this._anchor);

        let before = 0;
        for (let i = 0; i < this._items.length; i++) {
            this._translate(this._items[i].slot, before + gains[i] / 2 - anchored);
            before += gains[i];
        }
        for (let i = 0; i < this._followers.length; i++)
            this._translate(this._followers[i], gainedBefore(followers[i]) - anchored);

        if (length > 0) {
            const stretch = (length + before) / length;
            this._backdrop.set_scale(this._vertical ? 1 : stretch, this._vertical ? stretch : 1);
            this._translate(this._backdrop, -anchored);
        }
    }
}
