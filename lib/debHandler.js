// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installs a DEB package for the whole system with `pkexec apt install`, on
// Debian, Ubuntu and the systems built on them. pkexec has the shell ask for
// an administrator's password; nothing here sees it.
//
// Only Gio and GLib are used here, nothing of the shell, so that this file
// can be tried out with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {InstallError} from './appImageHandler.js';
import {runCommand} from './subprocess.js';
import {APPLICATIONS_DIR, pickLauncher} from './systemLaunchers.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
// A .deb is an ar archive.
const AR_MAGIC = '!<arch>\n';

// pkexec's own exit codes; anything else is the command's.
const PKEXEC_DISMISSED = 126;     // the password dialog was dismissed
const PKEXEC_NOT_ALLOWED = 127;   // not authorized, or no one to ask

// What apt says, in English (it runs with LC_ALL=C, which pkexec passes on),
// and what it means. The first match wins.
const ERRORS = [
    ['no-space', /No space left|You don't have enough free space/i],
    ['busy', /Could not get lock|Unable to acquire the dpkg frontend lock|is another process using it/i],
    ['wrong-arch', /package architecture \(\S+\) does not match system|wrong architecture/i],
    ['newer-installed', /Packages were downgraded and -y was used|downgrad/i],
    ['dependency', /Unmet dependencies|but it is not (going to be )?install(able|ed)|held broken packages|Depends: /i],
    ['network', /Failed to fetch|Temporary failure resolving|Could not resolve|Unable to fetch some archives/i],
    ['invalid-deb', /is not a (debian format|correct package)|dpkg-deb: error|Invalid archive|unexpected end of file/i],
];

/** @returns {boolean} whether a file name looks like a DEB package */
export function isDeb(name) {
    return /\.deb$/i.test(name);
}

/**
 * Whether DEB packages can be installed here at all: with dpkg and apt.
 *
 * @returns {boolean}
 */
export function isSupported() {
    return ['dpkg', 'dpkg-deb', 'apt'].every(program => !!GLib.find_program_in_path(program));
}

/**
 * What a package file holds, read without installing it.
 *
 * @returns {Promise<{name: string, description: string|null, launchers: string[]}>}
 *   launchers are the desktop file ids it would install
 */
async function queryPackage(dpkgDeb, path, cancellable) {
    // dpkg-deb is lenient about what it reads; only an ar archive gets to it.
    const stream = await Gio.File.new_for_path(path).read_async(PRIORITY, cancellable);
    let magic;
    try {
        magic = (await stream.read_bytes_async(AR_MAGIC.length, PRIORITY, cancellable)).toArray();
    } finally {
        stream.close_async(PRIORITY, null).catch(() => {});
    }
    if (new TextDecoder().decode(magic) !== AR_MAGIC)
        throw new InstallError('invalid-deb');

    const options = {cancellable, env: {LC_ALL: 'C'}};
    const info = await runCommand([dpkgDeb, '--info', path], options);
    if (info.status !== 0)
        throw new InstallError('invalid-deb', info.stderr.trim().split('\n').pop() ?? '');
    const fields = parseInfo(info.stdout);
    if (!fields.Package)
        throw new InstallError('invalid-deb');

    // "-rw-r--r-- root/root  1234 2024-01-01 00:00 ./usr/share/applications/x.desktop"
    const contents = await runCommand([dpkgDeb, '--contents', path], options);
    const prefix = `.${APPLICATIONS_DIR}/`;
    const launchers = contents.stdout.split('\n')
        .map(line => line.slice(line.indexOf(` ${prefix}`) + 1))
        .filter(file => file.startsWith(prefix) && file.endsWith('.desktop') &&
            !file.slice(prefix.length).includes('/'))
        .map(file => file.slice(prefix.length));

    return {name: fields.Package, description: fields.Description ?? null, launchers};
}

/**
 * The control fields `dpkg-deb --info` prints, one space in:
 *
 *      Package: hello
 *      Description: example package based on GNU hello
 *       The GNU hello program produces a familiar, friendly greeting.
 *
 * @param {string} output
 * @returns {object} field name -> its first line
 */
export function parseInfo(output) {
    const fields = {};
    for (const line of output.split('\n')) {
        const match = line.match(/^ ([A-Za-z][\w-]*):\s*(.*)$/);
        if (match && !(match[1] in fields))
            fields[match[1]] = match[2].trim();
    }
    return fields;
}

async function isInstalled(name, cancellable) {
    const dpkgQuery = GLib.find_program_in_path('dpkg-query');
    if (!dpkgQuery)
        return false;
    const {status, stdout} = await runCommand(
        [dpkgQuery, '--show', '--showformat=${Status}', name], {cancellable, env: {LC_ALL: 'C'}});
    return status === 0 && /\binstalled$/.test(stdout.trim()) && !/not-installed/.test(stdout);
}

/**
 * The package a file would replace, if one of that name is installed.
 *
 * @param {string} path
 * @returns {Promise<{name: string, path: null}|null>}
 */
export async function findInstalled(path) {
    const dpkgDeb = GLib.find_program_in_path('dpkg-deb');
    if (!dpkgDeb)
        return null;
    const pkg = await queryPackage(dpkgDeb, path, null).catch(() => null);
    if (!pkg || !await isInstalled(pkg.name, null))
        return null;
    const launcher = await pickLauncher(pkg.name, pkg.launchers, Gio.File.new_for_path(APPLICATIONS_DIR), null);
    return {name: launcher?.name ?? pkg.name, path: null};
}

/**
 * What the user should know before a package is installed: what it is, and
 * whether its signature can be trusted. apt does not check the signature of
 * a package file, only of its repositories.
 *
 * @param {string} path
 * @returns {Promise<object[]>} {code: 'package-info', name, description}
 *   when the package can be read, then one of {code: 'unsigned'},
 *   {code: 'untrusted-key'}, {code: 'bad-signature'} or
 *   {code: 'signature-unchecked'} (no dpkg-sig to check with)
 */
export async function checkDebFile(path) {
    const notes = [];
    const dpkgDeb = GLib.find_program_in_path('dpkg-deb');
    const pkg = dpkgDeb ? await queryPackage(dpkgDeb, path, null).catch(() => null) : null;
    if (!pkg)
        return notes;   // installing it fails, and says why
    notes.push({code: 'package-info', name: pkg.name, description: pkg.description});

    const dpkgSig = GLib.find_program_in_path('dpkg-sig');
    if (!dpkgSig) {
        notes.push({code: 'signature-unchecked'});
        return notes;
    }
    const {stdout, stderr} = await runCommand([dpkgSig, '--verify', path], {env: {LC_ALL: 'C'}})
        .catch(() => ({stdout: '', stderr: ''}));
    const verdict = classifySignature(`${stdout}\n${stderr}`);
    if (verdict !== 'ok')
        notes.push({code: verdict});
    return notes;
}

/**
 * Reads what `dpkg-sig --verify` said about a package: a line with GOODSIG,
 * BADSIG, UNKNOWNSIG (signed with a key not in the keyring) or NOSIG.
 *
 * @param {string} output
 * @returns {string} 'ok', 'bad-signature', 'untrusted-key', 'unsigned', or
 *   'signature-unchecked' when it said none of these
 */
export function classifySignature(output) {
    const words = new Set(output.match(/\b(GOODSIG|BADSIG|UNKNOWNSIG|NOSIG)\b/g) ?? []);
    if (words.has('BADSIG'))
        return 'bad-signature';
    if (words.has('UNKNOWNSIG'))
        return 'untrusted-key';
    if (words.has('GOODSIG'))
        return 'ok';
    if (words.has('NOSIG'))
        return 'unsigned';
    return 'signature-unchecked';
}

/**
 * Installs a DEB package with apt, which also brings in what it depends on.
 * A package that is installed already is upgraded, or left as it is.
 *
 * @param {string} path
 * @param {object} [params]
 * @param {Gio.Cancellable} [params.cancellable] - kills pkexec; apt, already
 *   running as root by then, may still finish
 * @param {string} [params.pkexec] - for tests
 * @param {string} [params.apt] - for tests
 * @param {string} [params.applicationsDir] - for tests
 * @returns {Promise<{desktopId: string|null, name: string, path: string, replaced: boolean}>}
 *   desktopId is null for a package without a launcher
 */
export async function installDeb(path, {
    cancellable = null,
    pkexec = GLib.find_program_in_path('pkexec'),
    apt = GLib.find_program_in_path('apt'),
    applicationsDir = APPLICATIONS_DIR,
} = {}) {
    const dpkgDeb = GLib.find_program_in_path('dpkg-deb');
    if (!apt || !dpkgDeb)
        throw new InstallError('no-apt');
    if (!pkexec)
        throw new InstallError('no-pkexec');

    await Gio.File.new_for_path(path).query_info_async('standard::type',
        Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable).catch(e => {
        throw new InstallError('not-a-file', e.message);
    });
    const pkg = await queryPackage(dpkgDeb, path, cancellable);
    const replaced = await isInstalled(pkg.name, cancellable);

    // The path is absolute, which tells apt it is a file and not the name of
    // a package. No time limit: apt may have a lot to download, and the
    // password dialog waits for the user.
    const {status, stdout, stderr} = await runCommand(
        [pkexec, apt, 'install', '-y', path],
        {cancellable, env: {LC_ALL: 'C'}});
    if (status !== 0)
        throw describeFailure(status, `${stderr}\n${stdout}`);

    const launcher = await pickLauncher(pkg.name, pkg.launchers, Gio.File.new_for_path(applicationsDir), cancellable);
    return {
        desktopId: launcher?.desktopId ?? null,
        name: launcher?.name ?? pkg.name,
        path,
        replaced,
    };
}

/**
 * Puts the way pkexec or apt failed into one of the codes the installer has
 * words for. The message is the line apt gave as the reason, for the details.
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

    const lines = output.split('\n').map(line => line.trim())
        .filter(line => line && !/^WARNING: apt does not have a stable CLI/.test(line));
    // The most telling line: what is missing, or else apt's last error.
    const reason = lines.find(line => /Depends: |not installable|does not match system/i.test(line)) ??
        [...lines].reverse().find(line => /^E:/.test(line)) ??
        lines[lines.length - 1] ?? `apt exited with status ${status}`;
    const [code] = ERRORS.find(([, pattern]) => pattern.test(output)) ?? ['apt-failed'];
    return new InstallError(code, reason.replace(/^E:\s*/, ''));
}
