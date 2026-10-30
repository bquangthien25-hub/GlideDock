// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installs a Flatpak app for the current user from a .flatpakref (a pointer
// to an app in a remote repository) or a .flatpak bundle (the app itself).
// `flatpak install --user` does the work; no root needed.
//
// Only Gio and GLib are used here, nothing of the shell, so that this file
// can be tried out with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {InstallError} from './appImageHandler.js';
import {runCommand} from './subprocess.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
const REF_GROUP = 'Flatpak Ref';
const DESKTOP_GROUP = 'Desktop Entry';

// What flatpak says, in English (it runs with LC_ALL=C), and what it means.
// The first match wins.
const ERRORS = [
    ['no-space', /No space left/i],
    ['missing-runtime', /requires the runtime \S+ which (was not found|is not installed)|runtime \S+ (was )?not found/i],
    ['network', /Could not resolve|Could not connect|Couldn't resolve|Timeout was reached|Network is unreachable|Connection refused/i],
    ['no-remote', /No remote|Remote \S+ not found|No such remote|No such ref|disabled remote|Nothing matches|No ref chosen/i],
    ['invalid-file', /Invalid \.?flatpakref|Invalid bundle|Invalid checksum|not a valid|Invalid file format|Error parsing|Key file does not have|bad magic|GPG signatures found, but none are in trusted keyring/i],
];

/** @returns {boolean} whether a file name looks like a Flatpak ref or bundle */
export function isFlatpak(name) {
    return /\.(flatpakref|flatpak)$/i.test(name);
}

function isRef(path) {
    return /\.flatpakref$/i.test(path);
}

// Where flatpak exports the launchers of user and system installs.
function exportDirs() {
    const user = GLib.getenv('FLATPAK_USER_DIR') ??
        GLib.build_filenamev([GLib.get_user_data_dir(), 'flatpak']);
    const system = GLib.getenv('FLATPAK_SYSTEM_DIR') ?? '/var/lib/flatpak';
    return [user, system].map(dir =>
        Gio.File.new_for_path(GLib.build_filenamev([dir, 'exports', 'share', 'applications'])));
}

/**
 * The app a .flatpakref is for, if it is installed already, for the user or
 * the whole system. A bundle cannot tell without being opened, so for one
 * this is always null; installFlatpak tells afterwards.
 *
 * @param {string} path
 * @returns {Promise<{name: string, path: null}|null>}
 */
export async function findInstalled(path) {
    if (!isRef(path))
        return null;
    const ref = await readRef(Gio.File.new_for_path(path), null);
    if (!ref?.appId || ref.isRuntime)
        return null;
    const launcher = await findLauncher(ref.appId, null);
    return launcher ? {name: launcher.name ?? ref.title ?? ref.appId, path: null} : null;
}

/**
 * What the user should know before a Flatpak is installed: that what the app
 * may do (its permissions) is not shown, and how to see it afterwards.
 *
 * @param {string} path
 * @returns {Promise<{code: 'permissions-hidden', appId: string|null}[]>}
 *   appId is null for a bundle, which cannot tell without being opened
 */
export async function checkFlatpakFile(path) {
    const ref = isRef(path) ? await readRef(Gio.File.new_for_path(path), null).catch(() => null) : null;
    return [{code: 'permissions-hidden', appId: ref?.appId ?? null}];
}

/**
 * Installs a .flatpakref or .flatpak for the current user. An app that is
 * installed already is installed again: that is an update.
 *
 * @param {string} path
 * @param {object} [params]
 * @param {Gio.Cancellable} [params.cancellable]
 * @returns {Promise<{desktopId: string|null, name: string, path: string, replaced: boolean}>}
 *   desktopId is null for an app without a launcher
 */
export async function installFlatpak(path, {cancellable = null} = {}) {
    const flatpak = GLib.find_program_in_path('flatpak');
    if (!flatpak)
        throw new InstallError('no-flatpak');

    const file = Gio.File.new_for_path(path);
    const fromRef = isRef(path);
    let appId = null, title = null;
    if (fromRef) {
        const ref = await readRef(file, cancellable);
        if (!ref?.appId)
            throw new InstallError('invalid-file');
        if (ref.isRuntime)
            throw new InstallError('not-an-app');
        ({appId, title} = ref);
    } else {
        await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            PRIORITY, cancellable).catch(e => {
            throw new InstallError('not-a-file', e.message);
        });
    }

    const before = await listUserApps(flatpak, cancellable);
    // Installing an installed app is an update: --reinstall sees to that for
    // a bundle, and for a ref, which it does not apply to, `flatpak update`.
    // Downloads can take long, so there is no time limit; the install is
    // cancelled with the extension.
    const options = {cancellable, env: {LC_ALL: 'C'}};
    let {status, stdout, stderr} = await runCommand([
        flatpak, 'install', '--user', '--noninteractive', '-y', '--reinstall',
        fromRef ? '--from' : '--bundle', path,
    ], options);
    if (status !== 0 && fromRef && /is already installed/i.test(`${stderr}\n${stdout}`)) {
        ({status, stdout, stderr} = await runCommand(
            [flatpak, 'update', '--user', '--noninteractive', '-y', appId], options));
    }
    if (status !== 0)
        throw describeFailure(`${stderr}\n${stdout}`, status);

    // A bundle names its app only once it is in.
    if (!appId) {
        const after = await listUserApps(flatpak, cancellable);
        const added = after.filter(id => !before.includes(id));
        appId = added.length === 1 ? added[0] : findAppInOutput(`${stdout}\n${stderr}`, after);
    }
    if (!appId)
        throw new InstallError('flatpak-failed', 'Installed, but could not tell which app it was');

    const launcher = await findLauncher(appId, cancellable);
    return {
        desktopId: launcher?.desktopId ?? null,
        name: launcher?.name ?? title ?? appId,
        path,
        replaced: before.includes(appId),
    };
}

// The app ids installed for the user.
async function listUserApps(flatpak, cancellable) {
    const {status, stdout} = await runCommand(
        [flatpak, 'list', '--user', '--app', '--columns=application'],
        {cancellable, env: {LC_ALL: 'C'}});
    if (status !== 0)
        return [];
    return stdout.split('\n').map(line => line.trim()).filter(line => line);
}

// "Installing app/org.example.App/x86_64/stable", or the app id on a line
// of its own: the installed app the output mentions.
function findAppInOutput(output, installed) {
    const ref = output.match(/\bapp\/([A-Za-z0-9_.-]+)\//);
    if (ref)
        return ref[1];
    return installed.find(id => new RegExp(`(^|\\s)${id.replace(/\./g, '\\.')}(\\s|/|$)`, 'm').test(output)) ?? null;
}

/**
 * Puts what flatpak said into one of the codes the installer has words for.
 * The message is flatpak's own last error line, for the details.
 *
 * @param {string} output - stderr and stdout of the failed command
 * @param {number} status
 * @returns {InstallError}
 */
export function describeFailure(output, status) {
    const lines = output.split('\n').map(line => line.trim()).filter(line => line);
    const errorLine = [...lines].reverse().find(line => /^error:/i.test(line)) ??
        lines[lines.length - 1] ?? `flatpak exited with status ${status}`;
    const message = errorLine.replace(/^error:\s*/i, '');
    const [code] = ERRORS.find(([, pattern]) => pattern.test(output)) ?? ['flatpak-failed'];
    return new InstallError(code, message);
}

async function readRef(file, cancellable) {
    try {
        const [contents] = await file.load_contents_async(cancellable);
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_bytes(new GLib.Bytes(contents), GLib.KeyFileFlags.NONE);
        const get = key => {
            try {
                return keyFile.get_string(REF_GROUP, key);
            } catch {
                return null;
            }
        };
        return {
            appId: get('Name'),
            title: get('Title'),
            isRuntime: get('IsRuntime')?.toLowerCase() === 'true',
        };
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw new InstallError('not-a-file', e.message);
        return null;
    }
}

/**
 * The launcher flatpak exported for an app: <app id>.desktop, or else the
 * first other one whose name starts with the app id.
 *
 * @returns {Promise<{desktopId: string, name: string|null}|null>}
 */
async function findLauncher(appId, cancellable) {
    for (const dir of exportDirs()) {
        const exact = dir.get_child(`${appId}.desktop`);
        // eslint-disable-next-line no-await-in-loop
        let found = await exists(exact, cancellable) ? exact : null;
        if (!found) {
            // eslint-disable-next-line no-await-in-loop
            const names = await listNames(dir, cancellable);
            const name = names.sort().find(n => n.startsWith(`${appId}.`) && n.endsWith('.desktop'));
            found = name ? dir.get_child(name) : null;
        }
        if (found) {
            // eslint-disable-next-line no-await-in-loop
            return {desktopId: found.get_basename(), name: await readName(found, cancellable)};
        }
    }
    return null;
}

async function exists(file, cancellable) {
    try {
        await file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            PRIORITY, cancellable);
        return true;
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return false;
    }
}

async function listNames(dir, cancellable) {
    try {
        const enumerator = await dir.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable);
        const names = [];
        let infos;
        do {
            // eslint-disable-next-line no-await-in-loop
            infos = await enumerator.next_files_async(64, PRIORITY, cancellable);
            names.push(...infos.map(info => info.get_name()));
        } while (infos.length > 0);
        return names;
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return [];
    }
}

async function readName(file, cancellable) {
    try {
        const [contents] = await file.load_contents_async(cancellable);
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_bytes(new GLib.Bytes(contents), GLib.KeyFileFlags.KEEP_TRANSLATIONS);
        return keyFile.get_locale_string(DESKTOP_GROUP, 'Name', null);
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return null;
    }
}
