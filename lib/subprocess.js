// SPDX-License-Identifier: GPL-2.0-or-later
//
// The one place where GlideDock starts other programs. Everything here is
// asynchronous: the shell must never wait for a child process.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
// The shell promisifies this one too, and only the first time counts, so a
// line may come back as bytes or as text; see startProcess.
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

/**
 * Runs a command to its end and collects what it printed.
 *
 * @param {string[]} argv
 * @param {object} [params]
 * @param {string} [params.cwd] - working directory of the command
 * @param {number} [params.timeout] - seconds before the command is killed; 0 for none
 * @param {Gio.Cancellable} [params.cancellable] - kills the command when cancelled
 * @param {object} [params.env] - environment variables to set for the command
 * @returns {Promise<{status: number, stdout: string, stderr: string}>}
 */
export async function runCommand(argv, {cwd = null, timeout = 0, cancellable = null, env = {}} = {}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE |
            Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    if (cwd)
        launcher.set_cwd(cwd);
    for (const [name, value] of Object.entries(env))
        launcher.setenv(name, value, true);
    const proc = launcher.spawnv(argv);

    let timeoutId = 0;
    if (timeout > 0) {
        timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeout, () => {
            timeoutId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
    }
    const cancelId = cancellable?.connect(() => proc.force_exit()) ?? 0;

    try {
        // An empty stdin: a command that asks a question gets no answer.
        const [stdout, stderr] = await proc.communicate_utf8_async('', null);
        return {
            status: proc.get_if_exited() ? proc.get_exit_status() : -1,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
        };
    } finally {
        if (timeoutId)
            GLib.source_remove(timeoutId);
        if (cancelId)
            cancellable.disconnect(cancelId);
    }
}

/**
 * Starts a program that keeps running, and reads what it prints line by line.
 *
 * @param {string[]} argv
 * @param {Function} onLine - called with each line printed on stdout
 * @returns {{pid: number, stop: Function, wait: Promise<void>}} stop kills the
 *   program; wait settles once it has gone, whichever way
 */
export function startProcess(argv, onLine) {
    const proc = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
    const stdout = new Gio.DataInputStream({
        base_stream: proc.get_stdout_pipe(),
        close_base_stream: true,
    });
    const cancellable = new Gio.Cancellable();
    const decoder = new TextDecoder();

    const wait = (async () => {
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (line === null)
                    break;
                onLine(typeof line === 'string' ? line : decoder.decode(line));
            }
        } catch {
            // Stopped, or the program went away mid-line.
        }
        proc.force_exit();
    })();

    return {
        pid: Number(proc.get_identifier()),
        stop: () => {
            cancellable.cancel();
            proc.force_exit();
        },
        wait,
    };
}
