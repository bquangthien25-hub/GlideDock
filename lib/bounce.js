// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

const RISE_TIME = 280;   // ms; from rest to the top of a bounce
const FALL_TIME = 280;   // ms; and back down
// ms; an app that has nothing to show by then is left alone. Some never say
// that they have started (AppImages, mostly), and would bounce for ever.
const MAX_TIME = 4000;
const MAX_BOUNCES = Math.max(1, Math.floor(MAX_TIME / (RISE_TIME + FALL_TIME)));

const bouncing = new WeakSet();

/**
 * Bounces an actor away from its place and back, again and again, until
 * `isDone()` says so. It always stops with the actor back at rest.
 *
 * Only the actor's translation is animated: a paint-time transform that
 * leaves its allocation, and anything that scales it, alone.
 *
 * @param {Clutter.Actor} actor
 * @param {number[]} offset - [x, y] of the top of a bounce, relative to rest
 * @param {Function} isDone - asked every time the actor lands
 */
export function bounceUntil(actor, [x, y], isDone) {
    if (bouncing.has(actor) || !St.Settings.get().enable_animations)
        return;
    bouncing.add(actor);

    // An animation that did not finish was cut short by the actor going
    // away; there is nothing left to put back then.
    let count = 0;
    const rise = () => actor.ease({
        translation_x: x,
        translation_y: y,
        duration: RISE_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onStopped: finished => finished ? fall() : bouncing.delete(actor),
    });
    const fall = () => actor.ease({
        translation_x: 0,
        translation_y: 0,
        duration: FALL_TIME,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onStopped: finished => {
            if (finished && ++count < MAX_BOUNCES && !isDone())
                rise();
            else
                bouncing.delete(actor);
        },
    });
    rise();
}
