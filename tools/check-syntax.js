// SPDX-License-Identifier: GPL-2.0-or-later
//
// Parses each file given on the command line as an ES module and reports
// syntax errors, without importing anything. Run with: gjs tools/check-syntax.js FILE...

const {GLib} = imports.gi;

let failed = false;
for (const path of ARGV) {
    const [, bytes] = GLib.file_get_contents(path);
    const source = new TextDecoder().decode(bytes);
    try {
        Reflect.parse(source, {target: 'module', source: path});
    } catch (e) {
        failed = true;
        printerr(`${path}:${e.lineNumber}:${e.columnNumber}: ${e.message}`);
    }
}
imports.system.exit(failed ? 1 : 0);
