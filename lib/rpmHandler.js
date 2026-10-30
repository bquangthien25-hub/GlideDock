// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installs an RPM package for the whole system with `pkexec dnf install`.
// pkexec has the shell ask for an administrator's password; nothing here
// sees it.
//
// Only Gio and GLib are used here, nothing of the shell, so that this file
// can be tried out with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {InstallError} from './appImageHandler.js';
import {runCommand} from './subprocess.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
const DESKTOP_GROUP = 'Desktop Entry';
const APPLICATIONS_DIR = '/usr/share/applications';

// pkexec's own exit codes; anything else is the command's.
const PKEXEC_DISMISSED = 126;     // the password dialog was dismissed
const PKEXEC_NOT_ALLOWED = 127;   // not authorized, or no one to ask

// What dnf says, in English (it runs with LC_ALL=C, which pkexec passes
// on), and what it means. The first match wins.
const ERRORS = [
    ['no-space', /No space left|needs? .* more space|Not enough (free )?(disk )?space/i],
    ['busy', /transaction lock|Waiting for process|another (copy|instance)|is locked/i],
    ['untrusted', /OpenPGP|GPG|signature|Public key .* is not installed|is not signed|NOKEY|key .* not (installed|found)/i],
    ['wrong-arch', /compatible architecture|different architecture|intended for a different/i],
    ['dependency', /nothing provides|conflicting requests|none of the providers|requires .* but|broken dependencies|cannot install both|Problem( \d+)?:|conflicts with/i],
    ['newer-installed', /lower version|is newer than|older than (the )?installed|downgrade/i],
    ['network', /Cannot download|Curl error|Failed to download|Could not resolve host|Couldn't resolve/i],
];

/** @returns {boolean} whether a file name looks like an RPM package */
export function isRpm(name) {
    return /\.rpm$/i.test(name);
}

/**
 * What a package file holds, read without installing it.
 *
 * @returns {Promise<{name: string, sourceOnly: boolean, launchers: string[]}>}
 *   launchers are the desktop file ids it would install
 */
async function queryPackage(rpm, path, cancellable) {
    // rpm reads a file that is not a package as a list of packages to read
    // instead. Only a package, starting with the RPM lead, gets that far.
    const stream = await Gio.File.new_for_path(path).read_async(PRIORITY, cancellable);
    let magic;
    try {
        magic = (await stream.read_bytes_async(4, PRIORITY, cancellable)).toArray();
    } finally {
        stream.close_async(PRIORITY, null).catch(() => {});
    }
    if (magic.length < 4 || magic[0] !== 0xed || magic[1] !== 0xab || magic[2] !== 0xee || magic[3] !== 0xdb)
        throw new InstallError('invalid-rpm');

    const options = {cancellable, env: {LC_ALL: 'C'}};
    const info = await runCommand(
        [rpm, '-qp', '--nosignature', '--nodigest', '--qf', '%{NAME}\\n%{SOURCERPM}\\n', path], options);
    if (info.status !== 0)
        throw new InstallError('invalid-rpm', info.stderr.trim().split('\n').pop() ?? '');
    const [name, sourceRpm] = info.stdout.split('\n');

    const files = await runCommand([rpm, '-qpl', '--nosignature', '--nodigest', path], options);
    const prefix = `${APPLICATIONS_DIR}/`;
    const launchers = files.stdout.split('\n')
        .filter(file => file.startsWith(prefix) && file.endsWith('.desktop') &&
            !file.slice(prefix.length).includes('/'))
        .map(file => file.slice(prefix.length));

    // A source package has no source package of its own.
    return {name, sourceOnly: !sourceRpm || sourceRpm === '(none)', launchers};
}

async function isInstalled(rpm, name, cancellable) {
    const {status} = await runCommand([rpm, '-q', '--quiet', name], {cancellable});
    return status === 0;
}

/**
 * The package a file would replace, if one of that name is installed.
 *
 * @param {string} path
 * @returns {Promise<{name: string, path: null}|null>}
 */
export async function findInstalled(path) {
    const rpm = GLib.find_program_in_path('rpm');
    if (!rpm)
        return null;
    const pkg = await queryPackage(rpm, path, null).catch(() => null);
    if (!pkg || !await isInstalled(rpm, pkg.name, null))
        return null;
    const launcher = await pickLauncher(pkg, Gio.File.new_for_path(APPLICATIONS_DIR), null);
    return {name: launcher?.name ?? pkg.name, path: null};
}

/**
 * Installs an RPM package with dnf, which also brings in what it depends on.
 * A package that is installed already is upgraded, or left as it is.
 *
 * @param {string} path
 * @param {object} [params]
 * @param {Gio.Cancellable} [params.cancellable] - kills pkexec; dnf, already running
 *   as root by then, may still finish
 * @param {string} [params.pkexec] - for tests
 * @param {string} [params.dnf] - for tests
 * @param {string} [params.applicationsDir] - for tests
 * @returns {Promise<{desktopId: string|null, name: string, path: string, replaced: boolean}>}
 *   desktopId is null for a package without a launcher
 */
export async function installRpm(path, {
    cancellable = null,
    pkexec = GLib.find_program_in_path('pkexec'),
    dnf = GLib.find_program_in_path('dnf'),
    applicationsDir = APPLICATIONS_DIR,
} = {}) {
    const rpm = GLib.find_program_in_path('rpm');
    if (!dnf || !rpm)
        throw new InstallError('no-dnf');
    if (!pkexec)
        throw new InstallError('no-pkexec');

    await Gio.File.new_for_path(path).query_info_async('standard::type',
        Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable).catch(e => {
        throw new InstallError('not-a-file', e.message);
    });
    const pkg = await queryPackage(rpm, path, cancellable);
    if (pkg.sourceOnly)
        throw new InstallError('source-rpm');
    const replaced = await isInstalled(rpm, pkg.name, cancellable);

    // No time limit: dnf may have a lot to download, and the password
    // dialog waits for the user.
    const {status, stdout, stderr} = await runCommand(
        [pkexec, dnf, 'install', '-y', path],
        {cancellable, env: {LC_ALL: 'C'}});
    if (status !== 0)
        throw describeFailure(status, `${stderr}\n${stdout}`);

    const launcher = await pickLauncher(pkg, Gio.File.new_for_path(applicationsDir), cancellable);
    return {
        desktopId: launcher?.desktopId ?? null,
        name: launcher?.name ?? pkg.name,
        path,
        replaced,
    };
}

/**
 * Puts the way pkexec or dnf failed into one of the codes the installer has
 * words for. The message is the line dnf gave as the reason, for the details.
 *
 * @param {number} status
 * @param {string} output - stderr and stdout of the failed command
 * @returns {InstallError}
 */
export function describeFailure(status, output) {
    if (status === PKEXEC_DISMISSED)
        return new InstallError('cancelled');
    if (status === PKEXEC_NOT_ALLOWED)
        return new InstallError('not-allowed', output.trim().split('\n').pop() ?? '');

    const lines = output.split('\n').map(line => line.trim()).filter(line => line);
    // The most telling line: what is missing, or else dnf's last word.
    const reason = lines.find(line => /nothing provides|conflicts with|OpenPGP|is not signed|key .* not/i.test(line)) ??
        [...lines].reverse().find(line => /^(Error|Failed|Transaction failed)/i.test(line)) ??
        lines[lines.length - 1] ?? `dnf exited with status ${status}`;
    const [code] = ERRORS.find(([, pattern]) => pattern.test(output)) ?? ['dnf-failed'];
    return new InstallError(code, reason.replace(/^(-\s*|Error:\s*)/i, ''));
}

// Of the launchers a package installs, the one to pin: one that is shown in
// menus, preferably named after the package.
async function pickLauncher(pkg, dir, cancellable) {
    const candidates = [];
    for (const desktopId of pkg.launchers) {
        // eslint-disable-next-line no-await-in-loop
        const entry = await readLauncher(dir.get_child(desktopId), cancellable);
        if (entry && !entry.hidden)
            candidates.push({desktopId, name: entry.name});
    }
    const named = name => name.toLowerCase().includes(pkg.name.toLowerCase());
    return candidates.find(({desktopId}) => named(desktopId)) ?? candidates[0] ?? null;
}

async function readLauncher(file, cancellable) {
    try {
        const [contents] = await file.load_contents_async(cancellable);
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_bytes(new GLib.Bytes(contents), GLib.KeyFileFlags.KEEP_TRANSLATIONS);
        const flag = key => {
            try {
                return keyFile.get_boolean(DESKTOP_GROUP, key);
            } catch {
                return false;
            }
        };
        let type = 'Application';
        try {
            type = keyFile.get_string(DESKTOP_GROUP, 'Type');
        } catch {
            // Application, then.
        }
        return {
            name: keyFile.get_locale_string(DESKTOP_GROUP, 'Name', null),
            hidden: type !== 'Application' || flag('NoDisplay') || flag('Hidden'),
        };
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return null;
    }
}
