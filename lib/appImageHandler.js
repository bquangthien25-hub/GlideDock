// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installs an AppImage for the current user, macOS style: the file goes to
// ~/Applications, and a launcher with the app's own name and icon is made
// for it. No root needed.
//
// Only Gio and GLib are used here, nothing of the shell, so that this file
// can be tried out with plain gjs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {runCommand} from './subprocess.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'trash_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const PRIORITY = GLib.PRIORITY_DEFAULT;
const EXTRACT_TIMEOUT = 60;   // seconds one extraction may take
const DESKTOP_GROUP = 'Desktop Entry';
const FALLBACK_ICON = 'application-x-executable';
// Marks launchers made by GlideDock, with the AppImage they start.
export const APPIMAGE_KEY = 'X-GlideDock-AppImage';

/** Why an install failed; `code` is for the installer to put into words. */
export class InstallError extends Error {
    /**
     * @param {string} code - such as 'not-a-file', 'not-appimage' or 'cancelled'
     * @param {string} [message]
     */
    constructor(code, message = code) {
        super(message);
        this.name = 'InstallError';
        this.code = code;
    }
}

/** @returns {boolean} whether a file name looks like an AppImage */
export function isAppImage(name) {
    return /\.appimage$/i.test(name);
}

/**
 * Moves an AppImage into ~/Applications, makes it executable and gives it a
 * launcher with the name and icon it carries inside.
 *
 * An app that is installed already is replaced: that is an update. Its
 * launcher is rewritten, and its old AppImage, if that had another name (an
 * older version, usually), goes to the trash.
 *
 * Nothing that is there already is touched without the user's say:
 * - a file in ~/Applications of the same name that GlideDock did not
 *   install ('unmanaged-file');
 * - the launcher of another AppImage, which this one would take over because
 *   it carries a launcher of the same name ('launcher-taken').
 * Either is asked about with `confirm`, unless agreed to already. Until
 * then, the AppImage waits in ~/Applications under a hidden name; it goes
 * back where it came from if the answer is no.
 *
 * @param {string} sourcePath - the AppImage, anywhere on a local disk
 * @param {object} [params]
 * @param {Gio.Cancellable} [params.cancellable]
 * @param {Function} [params.confirm] - async, given a question
 *   ({code: 'unmanaged-file', path} or {code: 'launcher-taken', name, path,
 *   newName}); resolves to whether to go on. No by default.
 * @param {string} [params.overwrite] - a file in ~/Applications the user has
 *   agreed to replace already
 * @param {string} [params.replacing] - the AppImage the user has agreed to
 *   replace already, as findInstalled gave it
 * @param {string} [params.applicationsDir] - where AppImages go; ~/Applications by default
 * @param {string} [params.dataDir] - where launchers and icons go; ~/.local/share by default
 * @returns {Promise<{desktopId: string, name: string, path: string, replaced: boolean}>}
 *   replaced tells whether the app was installed already
 */
export async function installAppImage(sourcePath, {
    cancellable = null,
    confirm = async () => false,
    overwrite = null,
    replacing = null,
    applicationsDir = GLib.build_filenamev([GLib.get_home_dir(), 'Applications']),
    dataDir = GLib.get_user_data_dir(),
} = {}) {
    const source = Gio.File.new_for_path(sourcePath);
    await checkAppImage(source, cancellable);

    const appsDir = Gio.File.new_for_path(applicationsDir);
    await makeDirectory(appsDir, cancellable);
    const target = appsDir.get_child(source.get_basename());
    const inPlace = source.equal(target);

    // 1. A file of the same name that is not ours: only with the user's say.
    let unmanaged = false;
    if (!inPlace && await exists(target, cancellable)) {
        const managed = await managedAppImages(dataDir, cancellable);
        unmanaged = !managed.has(target.get_path());
        if (unmanaged && overwrite !== target.get_path() &&
            !await confirm({code: 'unmanaged-file', path: target.get_path()}))
            throw new InstallError('cancelled');
    }

    // 2. Into ~/Applications, under a hidden name until it is certain to stay.
    const staged = inPlace ? target : appsDir.get_child(`.${target.get_basename()}.glidedock-part`);
    if (!inPlace) {
        await source.move_async(staged, Gio.FileCopyFlags.OVERWRITE,
            PRIORITY, cancellable, null);
    }
    const info = await staged.query_info_async('unix::mode',
        Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable);
    const oldMode = info.get_attribute_uint32('unix::mode');
    const rollBack = async () => {
        await setMode(staged, oldMode, null).catch(() => {});
        if (!inPlace)
            await staged.move_async(source, Gio.FileCopyFlags.NONE, PRIORITY, null, null);
    };

    const tmp = Gio.File.new_for_path(GLib.dir_make_tmp('glidedock-XXXXXX'));
    try {
        let desktopId, keyFile, launcher, previous, name, icon;
        try {
            // 3. Executable, for whoever may read it.
            await setMode(staged, oldMode | ((oldMode & 0o444) >> 2), cancellable);

            // 4. What it says about itself: its launcher and its icon. An
            //    AppImage that cannot tell still gets a launcher, named after
            //    the file.
            let embedded = null;
            let id;
            try {
                embedded = await extractDesktopEntry(staged, tmp, cancellable);
                id = launcherId(embedded?.file.get_basename() ?? target.get_basename());
                const iconName = embedded?.keyFile ? readString(embedded.keyFile, 'Icon') : null;
                icon = await extractIcon(staged, tmp, iconName, cancellable);
            } catch (e) {
                if (cancellable?.is_cancelled())
                    throw e;
                console.warn(`GlideDock: could not read ${target.get_path()}: ${e.message}`);
                id ??= launcherId(target.get_basename());
            }

            const iconsDir = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'glidedock', 'icons']));
            const iconTarget = icon ? iconsDir.get_child(`${id}.${icon.extension}`) : null;
            keyFile = makeDesktopEntry(embedded?.keyFile ?? null, {
                appImagePath: target.get_path(),
                iconPath: iconTarget?.get_path() ?? null,
                fallbackName: prettyName(target.get_basename()),
            });
            name = keyFile.get_locale_string(DESKTOP_GROUP, 'Name', null);
            icon = icon ? {...icon, target: iconTarget, dir: iconsDir} : null;

            // 5. The launcher of another AppImage, of another app or another
            //    copy: only with the user's say.
            desktopId = `${id}.desktop`;
            launcher = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'applications', desktopId]));
            previous = await readLauncher(launcher, cancellable);
            const other = previous?.appImagePath;
            if (other && other !== target.get_path() && other !== replacing &&
                await exists(Gio.File.new_for_path(other), cancellable) &&
                !await confirm({code: 'launcher-taken', name: previous.name, path: other, newName: name}))
                throw new InstallError('cancelled');
        } catch (e) {
            await rollBack().catch(err =>
                console.warn(`GlideDock: could not put back ${sourcePath}: ${err.message}`));
            throw e;
        }

        // 6. Agreed: in place for good. A file that was not ours goes to the
        //    trash rather than being lost.
        if (!inPlace) {
            if (unmanaged)
                await target.trash_async(PRIORITY, cancellable).catch(() => {});
            await staged.move_async(target, Gio.FileCopyFlags.OVERWRITE,
                PRIORITY, cancellable, null);
        }
        if (icon) {
            await makeDirectory(icon.dir, cancellable);
            await icon.file.copy_async(icon.target, Gio.FileCopyFlags.OVERWRITE,
                PRIORITY, cancellable, null);
        }

        // 7. The launcher.
        await makeDirectory(launcher.get_parent(), cancellable);
        const [data] = keyFile.to_data();
        await launcher.replace_contents_bytes_async(
            new GLib.Bytes(new TextEncoder().encode(data)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable);

        // 8. The version it replaces. Only an AppImage of ours, of the same app.
        const old = previous?.appImagePath ? Gio.File.new_for_path(previous.appImagePath) : null;
        if (old && !old.equal(target) && appsDir.equal(old.get_parent()) &&
            previous.name?.toLowerCase() === name?.toLowerCase()) {
            try {
                await old.trash_async(PRIORITY, cancellable);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    console.warn(`GlideDock: could not move ${old.get_path()} to the trash: ${e.message}`);
            }
        }

        return {desktopId, name, path: target.get_path(), replaced: !!previous};
    } finally {
        await deleteRecursively(tmp).catch(() => {});
    }
}

/**
 * What the user should know before an AppImage is installed: whether a file
 * of the same name, which GlideDock did not install, is in ~/Applications.
 *
 * @param {string} path
 * @param {object} [params]
 * @param {string} [params.applicationsDir] - as for installAppImage
 * @param {string} [params.dataDir] - as for installAppImage
 * @returns {Promise<object[]>} questions as installAppImage asks them
 */
export async function checkAppImageFile(path, {
    applicationsDir = GLib.build_filenamev([GLib.get_home_dir(), 'Applications']),
    dataDir = GLib.get_user_data_dir(),
} = {}) {
    const source = Gio.File.new_for_path(path);
    const target = Gio.File.new_for_path(applicationsDir).get_child(source.get_basename());
    if (source.equal(target) || !await exists(target, null))
        return [];
    const managed = await managedAppImages(dataDir, null);
    return managed.has(target.get_path()) ? [] : [{code: 'unmanaged-file', path: target.get_path()}];
}

/**
 * The app an AppImage would most likely replace, if it is installed: one
 * whose AppImage has the same file name, or the same name once versions are
 * left out ("Obsidian-1.4.AppImage" for "Obsidian-1.5.AppImage"). A guess,
 * made before installing; installAppImage tells for sure afterwards.
 *
 * @param {string} path - of the AppImage about to be installed
 * @param {object} [params]
 * @param {string} [params.dataDir] - as for installAppImage
 * @returns {Promise<{name: string, path: string}|null>}
 */
export async function findInstalled(path, {dataDir = GLib.get_user_data_dir()} = {}) {
    const fileName = GLib.path_get_basename(path);
    const wanted = prettyName(fileName).toLowerCase();
    const matches = await ourLaunchers(dataDir, null);
    const found = matches.find(({appImagePath}) => GLib.path_get_basename(appImagePath) === fileName) ??
        matches.find(({appImagePath}) =>
            prettyName(GLib.path_get_basename(appImagePath)).toLowerCase() === wanted);
    return found ? {name: found.name, path: found.appImagePath} : null;
}

// The launchers we made that start an AppImage, as readLauncher gives them.
async function ourLaunchers(dataDir, cancellable) {
    const launchersDir = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'applications']));
    const children = await listChildren(launchersDir, cancellable).catch(e => {
        if (cancellable?.is_cancelled())
            throw e;
        return [];
    });
    const launchers = await Promise.all(children
        .filter(child => /^glidedock-.*\.desktop$/.test(child.get_basename()))
        .map(child => readLauncher(child, cancellable)));
    return launchers.filter(launcher => launcher?.appImagePath);
}

// The AppImages our launchers start: the ones GlideDock installed.
async function managedAppImages(dataDir, cancellable) {
    const launchers = await ourLaunchers(dataDir, cancellable);
    return new Set(launchers.map(({appImagePath}) => appImagePath));
}

// A launcher we made, as {name, appImagePath}; null if there is none.
async function readLauncher(file, cancellable) {
    try {
        const [contents] = await file.load_contents_async(cancellable);
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_bytes(new GLib.Bytes(contents), GLib.KeyFileFlags.NONE);
        return {
            name: keyFile.get_locale_string(DESKTOP_GROUP, 'Name', null),
            appImagePath: readString(keyFile, APPIMAGE_KEY),
        };
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return null;
    }
}

// An AppImage is an ELF program with "AI" and its type, 1 or 2, at byte 8.
// It is about to be run, so it had better be one.
async function checkAppImage(file, cancellable) {
    let info;
    try {
        info = await file.query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw new InstallError('not-a-file', e.message);
        throw e;
    }
    if (info.get_file_type() !== Gio.FileType.REGULAR)
        throw new InstallError('not-a-file');

    const stream = await file.read_async(PRIORITY, cancellable);
    let header;
    try {
        header = (await stream.read_bytes_async(16, PRIORITY, cancellable)).toArray();
    } finally {
        stream.close_async(PRIORITY, null).catch(() => {});
    }
    const isElf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
    const isAi = header[8] === 0x41 && header[9] === 0x49 && (header[10] === 1 || header[10] === 2);
    if (!isElf || !isAi)
        throw new InstallError('not-appimage');
}

// Runs the AppImage's own `--appimage-extract PATTERN` (type 2 only), which
// writes the matching files to ./squashfs-root without mounting anything.
// The pattern is matched like a shell glob; `*` does not cross `/`.
async function extract(appImage, tmp, pattern, cancellable) {
    const {status, stderr} = await runCommand(
        [appImage.get_path(), '--appimage-extract', pattern],
        {cwd: tmp.get_path(), timeout: EXTRACT_TIMEOUT, cancellable});
    if (status !== 0)
        throw new Error(`--appimage-extract failed (${status}): ${stderr.trim()}`);
    return tmp.get_child('squashfs-root');
}

// The launcher an AppImage carries at its top level, if it has one.
async function extractDesktopEntry(appImage, tmp, cancellable) {
    const root = await extract(appImage, tmp, '*.desktop', cancellable);
    const children = await listChildren(root, cancellable).catch(() => []);
    const file = children
        .filter(child => child.get_basename().endsWith('.desktop'))
        .sort((a, b) => a.get_basename().localeCompare(b.get_basename()))[0];
    if (!file)
        return null;

    const [contents] = await file.load_contents_async(cancellable);
    const keyFile = new GLib.KeyFile();
    keyFile.load_from_bytes(new GLib.Bytes(contents), GLib.KeyFileFlags.KEEP_TRANSLATIONS);
    if (!keyFile.has_group(DESKTOP_GROUP))
        return null;
    return {file, keyFile};
}

// The best icon the AppImage carries, as {file, extension}, extracted but
// not yet copied anywhere; null if it has none. The icon at the top level
// and .DirIcon are often links into usr/share/icons, so that is extracted too.
async function extractIcon(appImage, tmp, iconName, cancellable) {
    // Icon= is meant to be a name, but some give a path or an extension.
    const name = iconName ? GLib.path_get_basename(iconName).replace(/\.(png|svg|xpm)$/i, '') : null;

    const patterns = ['.DirIcon'];
    if (name)
        patterns.push(`${name}.*`, `usr/share/icons/hicolor/*/apps/${name}.*`);
    let root = null;
    for (const pattern of patterns) {
        try {
            // eslint-disable-next-line no-await-in-loop
            root = await extract(appImage, tmp, pattern, cancellable);
        } catch (e) {
            if (cancellable?.is_cancelled())
                throw e;
        }
    }
    if (!root)
        return null;

    // Sharpest first.
    const candidates = [];
    if (name) {
        const hicolor = 'usr/share/icons/hicolor';
        candidates.push(`${hicolor}/scalable/apps/${name}.svg`);
        for (const size of [512, 256, 192, 128, 96, 64, 48])
            candidates.push(`${hicolor}/${size}x${size}/apps/${name}.png`);
        candidates.push(`${name}.svg`, `${name}.png`);
    }
    candidates.push('.DirIcon');

    for (const candidate of candidates) {
        const file = root.resolve_relative_path(candidate);
        try {
            // eslint-disable-next-line no-await-in-loop
            const info = await file.query_info_async('standard::content-type',
                Gio.FileQueryInfoFlags.NONE, PRIORITY, cancellable);
            const type = info.get_content_type();
            const extension = Gio.content_type_is_a(type, 'image/svg+xml') ? 'svg'
                : Gio.content_type_is_a(type, 'image/png') ? 'png' : null;
            if (extension)
                return {file, extension};
        } catch (e) {
            // Not there, or a dangling link: try the next one.
            if (cancellable?.is_cancelled())
                throw e;
        }
    }
    return null;
}

/**
 * The launcher for an installed AppImage: the one it came with where there
 * is one, pointed at the AppImage's new place and icon.
 *
 * @param {GLib.KeyFile|null} embedded - the launcher inside the AppImage
 * @param {object} params
 * @param {string} params.appImagePath
 * @param {string|null} params.iconPath
 * @param {string} params.fallbackName - for an AppImage without a launcher of its own
 * @returns {GLib.KeyFile}
 */
export function makeDesktopEntry(embedded, {appImagePath, iconPath, fallbackName}) {
    const keyFile = embedded ?? new GLib.KeyFile();
    const exec = quoteExecArg(appImagePath);

    keyFile.set_string(DESKTOP_GROUP, 'Type', 'Application');
    if (!readString(keyFile, 'Name'))
        keyFile.set_string(DESKTOP_GROUP, 'Name', fallbackName);
    if (!embedded) {
        keyFile.set_boolean(DESKTOP_GROUP, 'Terminal', false);
        keyFile.set_string(DESKTOP_GROUP, 'Categories', 'Utility;');
    }

    // The program is now the AppImage, whatever the arguments.
    for (const group of keyFile.get_groups()[0]) {
        if (group !== DESKTOP_GROUP && !group.startsWith('Desktop Action '))
            continue;
        const old = readString(keyFile, 'Exec', group);
        if (old === null && group !== DESKTOP_GROUP)
            continue;
        keyFile.set_string(group, 'Exec', old === null ? `${exec} %U` : replaceProgram(old, exec));
    }

    keyFile.set_string(DESKTOP_GROUP, 'TryExec', appImagePath);
    keyFile.set_string(DESKTOP_GROUP, 'Icon', iconPath ?? FALLBACK_ICON);
    keyFile.set_string(DESKTOP_GROUP, APPIMAGE_KEY, appImagePath);
    // It would be looked for on D-Bus under a name nothing owns.
    removeKey(keyFile, 'DBusActivatable');
    // These belong to the AppImage tools that made it, not to this copy.
    removeKey(keyFile, 'X-AppImage-Integrate');
    return keyFile;
}

// The first word of an Exec line is the program; the rest are arguments.
function replaceProgram(execLine, program) {
    const rest = execLine.replace(/^\s*("(?:[^"\\]|\\.)*"|\S+)/, '');
    return `${program}${rest}`;
}

// Quoting of the Exec key (Desktop Entry spec, "The Exec key"). The key file
// escapes backslashes once more when it is written; the spec wants both.
function quoteExecArg(arg) {
    return `"${arg.replace(/[\\"`$]/g, c => `\\${c}`).replace(/%/g, '%%')}"`;
}

// A desktop file id that is ours and stays the same across updates:
// "Obsidian-1.5.3-x86_64.AppImage" and "obsidian.desktop" both give
// "glidedock-obsidian".
export function launcherId(fileName) {
    const slug = stripVersion(fileName)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `glidedock-${slug || 'app'}`;
}

// "Obsidian-1.5.3-x86_64.AppImage" -> "Obsidian"
export function prettyName(fileName) {
    return stripVersion(fileName).replace(/[-_]+/g, ' ').trim() || fileName;
}

function stripVersion(fileName) {
    return fileName
        .replace(/\.(appimage|desktop)$/i, '')
        .replace(/[-_. ]?(x86[-_]64|amd64|aarch64|arm64|armhf|i[3-6]86)\b/ig, '')
        .replace(/[-_ ]v?\d+(\.\d+)+.*$/i, '');
}

function readString(keyFile, key, group = DESKTOP_GROUP) {
    try {
        return keyFile.get_string(group, key);
    } catch {
        return null;
    }
}

function removeKey(keyFile, key) {
    try {
        keyFile.remove_key(DESKTOP_GROUP, key);
    } catch {
        // Not there.
    }
}

async function exists(file, cancellable) {
    try {
        await file.query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, cancellable);
        return true;
    } catch (e) {
        if (cancellable?.is_cancelled())
            throw e;
        return false;
    }
}

async function setMode(file, mode, cancellable) {
    const info = new Gio.FileInfo();
    info.set_attribute_uint32('unix::mode', mode);
    await file.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE,
        PRIORITY, cancellable);
}

// mkdir -p
async function makeDirectory(dir, cancellable) {
    try {
        await dir.make_directory_async(PRIORITY, cancellable);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !dir.get_parent())
            throw e;
        await makeDirectory(dir.get_parent(), cancellable);
        await dir.make_directory_async(PRIORITY, cancellable);
    }
}

async function listChildren(dir, cancellable) {
    const enumerator = await dir.enumerate_children_async('standard::name',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, cancellable);
    const children = [];
    let infos;
    do {
        // eslint-disable-next-line no-await-in-loop
        infos = await enumerator.next_files_async(64, PRIORITY, cancellable);
        children.push(...infos.map(info => enumerator.get_child(info)));
    } while (infos.length > 0);
    return children;
}

// rm -r, without following links out of the directory.
async function deleteRecursively(file) {
    const info = await file.query_info_async('standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, PRIORITY, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const children = await listChildren(file, null);
        await Promise.all(children.map(child => deleteRecursively(child)));
    }
    await file.delete_async(PRIORITY, null);
}
