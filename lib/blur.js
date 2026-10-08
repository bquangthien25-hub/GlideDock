// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

// Shell.BlurEffect can only blur a rectangle. This effect cuts the blurred
// rectangle down to a rounded one, with a one pixel soft edge.
const DECLARATIONS = `
uniform vec2 glidedock_size;
uniform float glidedock_radius;

float glidedock_coverage(vec2 point) {
    vec2 half_size = glidedock_size * 0.5;
    vec2 corner = abs(point - half_size) - (half_size - glidedock_radius);
    float distance = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - glidedock_radius;
    return clamp(0.5 - distance, 0.0, 1.0);
}`;
const CODE =
    'cogl_color_out *= glidedock_coverage(cogl_tex_coord_in[0].st * glidedock_size);';

const RoundedClipEffect = GObject.registerClass(
class GlideDockRoundedClipEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        // The hook enum moved from Shell to Cogl in GNOME 48.
        const hook = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;
        this.add_glsl_snippet(hook, DECLARATIONS, CODE, false);
    }

    setShape(width, height, radius) {
        this.set_uniform_float(
            this.get_uniform_location('glidedock_size'), 2, [width, height]);
        this.set_uniform_float(
            this.get_uniform_location('glidedock_radius'), 1,
            [Math.min(radius, width / 2, height / 2)]);
        this.queue_repaint();
    }
});

/**
 * A blurred, rounded copy of the wallpaper to put behind a translucent dock.
 *
 * It is a copy of the wallpaper cut to the layer's rectangle, blurred, then
 * cut to a rounded shape. It only changes when the wallpaper does, so after
 * the first frame it costs one cached texture.
 *
 * The constructor throws if this shell cannot build it.
 */
export class BlurLayer {
    /** @param {number} monitorIndex - monitor whose wallpaper is shown */
    constructor(monitorIndex) {
        // Never asks for space of its own; the parent stretches it.
        this.actor = new Clutter.Actor({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            x_expand: true,
            y_expand: true,
            min_width: 0,
            min_height: 0,
            natural_width: 0,
            natural_height: 0,
        });

        try {
            // Effects wrap from last to first: blur the wallpaper, then round it.
            this._clipEffect = new RoundedClipEffect();
            this._blurEffect = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR});
            this.actor.add_effect(this._clipEffect);
            this.actor.add_effect(this._blurEffect);

            // BackgroundManager keeps a wallpaper actor in the holder up to
            // date across wallpaper changes.
            this._wallpaper = new Clutter.Actor({layout_manager: new Clutter.FixedLayout()});
            this.actor.add_child(this._wallpaper);
            this._manager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex,
                controlPosition: false,
                vignette: false,
            });
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    destroy() {
        this._manager?.destroy();
        this._manager = null;
        this.actor?.destroy();
        this.actor = null;
        this._wallpaper = null;
        this._clipEffect = null;
        this._blurEffect = null;
    }

    /**
     * @param {number} sigma - standard deviation of the blur, in physical pixels
     * @param {number} brightness - 0 (black) to 1 (unchanged)
     */
    setBlur(sigma, brightness) {
        // The property was called sigma before GNOME 46; radius is 2 sigma.
        if (this._blurEffect.radius !== undefined)
            this._blurEffect.radius = sigma * 2;
        else
            this._blurEffect.sigma = sigma;
        this._blurEffect.brightness = brightness;
    }

    /**
     * Lines the wallpaper copy up with the real wallpaper and sets the shape.
     * Uses a translation, so it is safe to call from allocation handlers.
     *
     * @param {number} offsetX - monitor origin minus the layer's origin, in stage pixels
     * @param {number} offsetY - same, vertically
     * @param {number} radius - corner radius in physical pixels
     */
    sync(offsetX, offsetY, radius) {
        this._wallpaper.set_translation(offsetX, offsetY, 0);
        this._clipEffect.setShape(this.actor.width, this.actor.height, radius);
    }
}
