// SPDX-License-Identifier: GPL-2.0-or-later
//
// A separate program, never imported by the shell. Run with:
//
//   gjs -m dropTarget.js WIDTH HEIGHT SUFFIX...
//
// The shell cannot take the files of a drag from another app: on Wayland
// only a window can be dropped on. So while files are dragged towards the
// dock, the extension starts this, a transparent window that it lays over
// the dock, and is told what is dropped on it. One JSON object per line on
// stdout:
//
//   {"event": "hover", "accept": true}   files are over the window; whether
//                                        any of them can be installed
//   {"event": "leave"}                   they went away again
//   {"event": "drop", "paths": [...]}    dropped; only files that can be installed
//
// It quits after a drop, when stdin closes (the shell went away), or when it
// has been around for too long.

import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const MAX_LIFETIME = 60;  // seconds

const [width, height, ...suffixes] = System.programArgs;
const loop = new GLib.MainLoop(null, false);

// print() flushes every line, so the shell reads it right away.
function send(message) {
    print(JSON.stringify(message));
}

function installable(files) {
    return files
        .map(file => file.get_path())
        .filter(path => path && suffixes.some(suffix => path.toLowerCase().endsWith(suffix)));
}

Gtk.init();

// Not quite transparent: a window that draws nothing at all is never shown.
// Above the user's own theme (~/.config/gtk-4.0/gtk.css), which would
// otherwise win and may paint it opaque. The shell hides it anyway; this
// only spares the theme's work.
const css = new Gtk.CssProvider();
const style = `window, window.background, window.csd, window.solid-csd {
    background: rgba(0, 0, 0, 0.004);
    background-image: none;
    border: none;
    border-radius: 0;
    box-shadow: none;
    outline: none;
}`;
if (css.load_from_string)
    css.load_from_string(style);
else
    css.load_from_data(style, -1);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
    Gtk.STYLE_PROVIDER_PRIORITY_USER + 1);

const window = new Gtk.Window({
    title: 'GlideDock drop target',
    decorated: false,
    resizable: false,
    default_width: Math.max(1, Number(width) || 1),
    default_height: Math.max(1, Number(height) || 1),
});
window.connect('close-request', () => {
    loop.quit();
    return false;
});

// Preloaded, so the files are known as soon as they arrive over the window,
// and the pointer can say right away whether they may be dropped.
const target = Gtk.DropTarget.new(Gdk.FileList.$gtype, Gdk.DragAction.COPY);
target.preload = true;
target.connect('notify::value', () => {
    const value = target.get_value();
    if (!value)
        return;
    const accept = installable(value.get_files()).length > 0;
    send({event: 'hover', accept});
    if (!accept)
        target.reject();
});
target.connect('leave', () => send({event: 'leave'}));
target.connect('drop', (_target, value) => {
    const paths = installable(value?.get_files() ?? []);
    if (paths.length === 0)
        return false;
    send({event: 'drop', paths});
    // A moment for the drop to finish on the side of the app it came from.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    return true;
});
window.add_controller(target);

// Nothing is ever written to stdin; it only stirs when it closes, which is
// when whoever started us has gone.
GLib.io_add_watch(GLib.IOChannel.unix_new(0), GLib.PRIORITY_DEFAULT,
    GLib.IOCondition.IN | GLib.IOCondition.HUP | GLib.IOCondition.ERR, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MAX_LIFETIME, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});

window.present();
send({event: 'ready'});
loop.run();
window.destroy();
