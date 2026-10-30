// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import * as AppImage from './appImageHandler.js';
import * as Flatpak from './flatpakHandler.js';
import * as Rpm from './rpmHandler.js';

const {InstallError} = AppImage;

// Seconds to wait for the shell to notice a new launcher. Flatpak's export
// directory may only now have been made, and is then checked for less often.
const APP_WAIT = 15;
const FLATHUB_COMMAND =
    'flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo';

// What can be installed, and how. `where` tells the user what installing
// does, in the question before it.
const HANDLERS = [{
    suffixes: ['.appimage'],
    accepts: AppImage.isAppImage,
    findInstalled: AppImage.findInstalled,
    check: AppImage.checkAppImageFile,
    install: AppImage.installAppImage,
    where: () => _('AppImages are moved to %s and added to the dock.').format('~/Applications'),
}, {
    suffixes: ['.flatpakref', '.flatpak'],
    accepts: Flatpak.isFlatpak,
    findInstalled: Flatpak.findInstalled,
    check: Flatpak.checkFlatpakFile,
    install: Flatpak.installFlatpak,
    where: () => _('Flatpak apps are installed for your user and added to the dock. Downloading may take a while.'),
}, {
    suffixes: ['.rpm'],
    accepts: Rpm.isRpm,
    isSupported: Rpm.isSupported,
    unsupported: () => _('RPM packages are not supported on this system. Use Flatpak or AppImage instead.'),
    findInstalled: Rpm.findInstalled,
    check: Rpm.checkRpmFile,
    install: Rpm.installRpm,
    where: () => _('RPM packages are installed for the whole system with dnf, which asks for your password.'),
}];

/** File name endings, lower case, of the files that can be installed. */
export const INSTALL_SUFFIXES = HANDLERS.flatMap(handler => handler.suffixes);

/**
 * Installs apps from files dropped on the dock, after asking, and pins them.
 *
 * Installs never block the shell. They run one after the other, since dnf
 * and flatpak each allow only one at a time anyway; the dock shows a
 * placeholder for each, waiting or installing (see `jobs`). Files dropped
 * while the question about others is open are asked about right after.
 */
export class Installer {
    /**
     * @param {Function} onJobsChanged - called when an install starts or ends
     */
    constructor(onJobsChanged) {
        this._onJobsChanged = onJobsChanged;
        this._jobs = [];
        this._nextJobId = 1;
        this._dialogs = new Set();
        this._asking = false;
        this._pending = [];              // paths dropped while asking
        this._queue = Promise.resolve(); // the installs, one after the other
        this._cancellable = new Gio.Cancellable();
        this._appSystem = Shell.AppSystem.get_default();
    }

    destroy() {
        this._cancellable.cancel();
        this._dialogs.forEach(dialog => dialog.close());
        this._dialogs.clear();
        this._onJobsChanged = null;
    }

    /** The installs to come, oldest first: {id, name, state}; state is 'waiting' or 'installing'. */
    get jobs() {
        return this._jobs;
    }

    /**
     * Asks whether to install the files that can be installed, then does.
     *
     * @param {string[]} paths
     */
    async installFiles(paths) {
        let files = paths
            .map(path => ({
                path,
                name: GLib.path_get_basename(path),
                handler: HANDLERS.find(h => h.accepts(path)),
            }))
            .filter(({handler}) => handler);
        // Kinds of files this system cannot install (RPM without dnf): said
        // so right away, rather than after asking.
        const unsupported = files.filter(({handler}) => handler.isSupported && !handler.isSupported());
        for (const {name, handler} of unsupported)
            Main.notify(_('Could not install %s').format(name), handler.unsupported());
        files = files.filter(file => !unsupported.includes(file));
        if (files.length === 0)
            return;
        if (this._asking) {
            this._pending.push(...files.map(({path}) => path));
            return;
        }

        let confirmed = false;
        this._asking = true;
        try {
            // Whatever is installed already gets replaced, and what else the
            // user should know before saying yes; the question says so.
            await Promise.all(files.map(async file => {
                [file.installed, file.warnings] = await Promise.all([
                    file.handler.findInstalled(file.path).catch(() => null),
                    file.handler.check(file.path).catch(() => []),
                ]);
            }));
            confirmed = !this._cancellable.is_cancelled() && await this._confirm(files);
        } finally {
            this._asking = false;
        }

        const installs = confirmed ? files.map(file => this._enqueue(file)) : [];
        const pending = [...new Set(this._pending.splice(0))];
        if (pending.length > 0 && !this._cancellable.is_cancelled())
            installs.push(this.installFiles(pending));
        await Promise.all(installs);
    }

    _enqueue(file) {
        const job = {id: this._nextJobId++, name: file.name, state: 'waiting'};
        this._jobs = [...this._jobs, job];
        this._onJobsChanged?.();
        this._queue = this._queue.then(() => this._install(job, file));
        return this._queue;
    }

    _confirm(files) {
        const [single] = files.length === 1 ? files : [null];
        const replacing = !!single?.installed;

        // One line per kind of file, on what installing it does.
        const where = [...new Set(files.map(({handler}) => handler))].map(h => h.where());
        // Then what the user should know about each file.
        const warnings = files.flatMap(({name, warnings: list}) =>
            (list ?? []).map(warning => describeWarning(warning, name)));
        let title, lines;
        if (replacing) {
            title = _('Replace “%s”?').format(single.installed.name);
            lines = [_('%s is already installed. It will be replaced by %s.')
                .format(single.installed.name, single.name), ...where];
        } else if (single) {
            title = _('Install “%s”?').format(single.name);
            lines = where;
        } else {
            title = _('Install these apps?');
            lines = [
                ...files.map(({name, installed}) => installed
                    ? _('%s (replaces the installed %s)').format(name, installed.name)
                    : name),
                '',
                ...where,
            ];
        }
        if (warnings.length > 0)
            lines.push('', ...warnings, '');
        lines.push(_('Only install apps from sources you trust.'));
        return this._ask(title, lines.join('\n'), replacing ? _('Replace') : _('Install'));
    }

    // A question that comes up while installing, such as an AppImage taking
    // over the launcher of another.
    _confirmDuringInstall(question, fileName) {
        let title, description;
        switch (question.code) {
        case 'unmanaged-file':
            title = _('Replace “%s”?').format(GLib.path_get_basename(question.path));
            description = describeWarning(question, fileName);
            break;
        case 'launcher-taken':
            title = _('Replace “%s”?').format(question.name);
            description = _('%s comes with the same launcher as %s, which is already installed from %s. If you go on, the launcher and dock icon of %s will open %s instead.')
                .format(fileName, question.name, tildePath(question.path), question.name, question.newName ?? fileName);
            break;
        default:
            return Promise.resolve(false);
        }
        // Something the user did not expect: no by default.
        return this._ask(title, description, _('Replace'), {cancelByDefault: true});
    }

    // A question with Cancel and another button; resolves to whether the
    // other button was chosen.
    _ask(title, description, acceptLabel, {cancelByDefault = false} = {}) {
        if (this._cancellable.is_cancelled())
            return Promise.resolve(false);
        return new Promise(resolve => {
            const dialog = new ModalDialog.ModalDialog({styleClass: 'glidedock-install-dialog'});
            dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));

            let answer = false;
            dialog.addButton({
                label: _('Cancel'),
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
                default: cancelByDefault,
            });
            dialog.addButton({
                label: acceptLabel,
                action: () => {
                    answer = true;
                    dialog.close();
                },
                default: !cancelByDefault,
            });
            dialog.connect('destroy', () => {
                this._dialogs.delete(dialog);
                resolve(answer && !this._cancellable.is_cancelled());
            });
            this._dialogs.add(dialog);
            if (!dialog.open())
                dialog.destroy();
        });
    }

    // Never throws: one failed install must not hold up the queue.
    async _install(job, {path, handler, installed, warnings}) {
        const fileName = job.name;
        if (this._cancellable.is_cancelled())
            return;
        // Replaced rather than changed, so that the dock sees the difference.
        const installing = {...job, state: 'installing'};
        this._jobs = this._jobs.map(other => other === job ? installing : other);
        this._onJobsChanged?.();

        try {
            const result = await handler.install(path, {
                cancellable: this._cancellable,
                // What the user has said yes to already, in the question before.
                replacing: installed?.path ?? null,
                overwrite: warnings?.find(({code}) => code === 'unmanaged-file')?.path ?? null,
                confirm: question => this._confirmDuringInstall(question, fileName),
            });
            // An app without a launcher (a command line tool) has no icon to pin.
            const app = result.desktopId ? await this._waitForApp(result.desktopId) : null;
            if (this._cancellable.is_cancelled())
                return;

            const name = app?.get_name() ?? result.name ?? fileName;
            const pinned = app ? this._pin(app.get_id()) : false;
            let body;
            if (!result.desktopId)
                body = _('It has no launcher, so it cannot be added to the dock.');
            else if (result.replaced)
                body = pinned ? _('It has been added to the dock.') : null;
            else
                body = app ? _('It has been added to the dock.') : _('It will show up in the app grid.');
            Main.notify((result.replaced ? _('%s is updated') : _('%s is installed')).format(name), body);
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            // The password dialog was dismissed: the user knows why.
            if (e instanceof InstallError && e.code === 'cancelled') {
                Main.notify(_('Installation of %s was cancelled').format(fileName));
                return;
            }
            console.warn(`GlideDock: could not install ${path}: ${e.message}`);
            Main.notify(_('Could not install %s').format(fileName), describeError(e, path));
        } finally {
            this._jobs = this._jobs.filter(other => other !== installing);
            this._onJobsChanged?.();
        }
    }

    // A new launcher is picked up by the shell a moment after it is written.
    _waitForApp(desktopId) {
        const app = this._appSystem.lookup_app(desktopId);
        if (app)
            return Promise.resolve(app);

        return new Promise(resolve => {
            let finished = false;
            let timeoutId = 0;
            const done = found => {
                if (finished)
                    return;
                finished = true;
                this._appSystem.disconnect(changedId);
                this._cancellable.disconnect(cancelId);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                resolve(found);
            };
            const changedId = this._appSystem.connect('installed-changed', () => {
                const found = this._appSystem.lookup_app(desktopId);
                if (found)
                    done(found);
            });
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, APP_WAIT, () => {
                timeoutId = 0;
                done(this._appSystem.lookup_app(desktopId));
                return GLib.SOURCE_REMOVE;
            });
            // A cancellable must not be disconnected from inside its own
            // handler, and calls back at once if it is cancelled already.
            const cancelId = this._cancellable.connect(() =>
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    done(null);
                    return GLib.SOURCE_REMOVE;
                }));
        });
    }

    // The same list the shell's own Pin to Dash writes to; the dock follows
    // it. Returns whether the app was not pinned before.
    _pin(appId) {
        const favorites = global.settings.get_strv('favorite-apps');
        if (favorites.includes(appId))
            return false;
        global.settings.set_strv('favorite-apps', [...favorites, appId]);
        return true;
    }
}

// ~/x for a path in the home folder, which is shorter to read.
function tildePath(path) {
    const home = GLib.get_home_dir();
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// For a command to copy: an id as it is, anything odd quoted.
function quoteIfNeeded(word) {
    return /^[\w.-]+$/.test(word) ? word : GLib.shell_quote(word);
}

// What the user should know about a file before installing it, in words.
function describeWarning(warning, fileName) {
    switch (warning.code) {
    case 'unmanaged-file':
        return _('%s is already in %s, but was not installed by GlideDock. If you go on, it is moved to the Trash.')
            .format(GLib.path_get_basename(warning.path), tildePath(GLib.path_get_dirname(warning.path)));
    case 'unsigned':
        return _('Warning: %s is not signed, so there is no way to tell who made it.').format(fileName);
    case 'untrusted-key':
        return _('Warning: %s is signed with a key this system does not trust.').format(fileName);
    case 'bad-signature':
        return _('Warning: the signature of %s does not match its contents. It may have been tampered with.').format(fileName);
    case 'permissions-hidden':
        return _('Flatpak permissions are not shown. Review permissions after install with: %s')
            .format(`flatpak info --show-permissions ${warning.appId ? quoteIfNeeded(warning.appId) : '<app-id>'}`);
    default:
        return '';
    }
}

// In words for a notification. Where flatpak said something more specific,
// that follows on a line of its own.
function describeError(error, path) {
    if (!(error instanceof InstallError))
        return error.message;

    const detail = text => `${text}\n${error.message}`;
    switch (error.code) {
    case 'not-a-file':
        return _('The file could not be found.');
    case 'not-appimage':
        return _('This file is not an AppImage.');
    case 'no-flatpak':
        return _('Flatpak is not installed. Install it with “%s”, then try again.')
            .format('sudo dnf install flatpak');
    case 'missing-runtime':
        return detail(_('A runtime it needs was not found. Add Flathub for your user with “%s”, then try again.')
            .format(FLATHUB_COMMAND));
    case 'no-remote':
        return detail(_('Its repository could not be reached, or does not have this app.'));
    case 'network':
        return _('The download failed. Check the internet connection, then try again.');
    case 'invalid-file':
        return _('This is not a valid Flatpak file.');
    case 'not-an-app':
        return _('This file installs a runtime, not an app.');
    case 'no-space':
        return _('There is not enough disk space.');
    case 'no-dnf':
        return _('RPM packages are not supported on this system. Use Flatpak or AppImage instead.');
    case 'no-pkexec':
        return _('pkexec is not available. Install it with “%s”, then try again.')
            .format('sudo dnf install polkit');
    case 'not-allowed':
        return _('Your account is not allowed to install software.');
    case 'dependency':
        return detail(_('Some packages it depends on could not be found.'));
    case 'untrusted':
        return detail(_('Its signature is not trusted. If you trust where it comes from, install it in a terminal with “%s”.')
            .format(`sudo dnf install --nogpgcheck ${GLib.shell_quote(path)}`));
    case 'wrong-arch':
        return _('It is made for a different kind of computer.');
    case 'newer-installed':
        return detail(_('A newer version is installed already.'));
    case 'busy':
        return _('Another installation is running. Try again once it has finished.');
    case 'invalid-rpm':
        return _('This is not a valid RPM package.');
    case 'source-rpm':
        return _('This is a source package: the code to build an app, not the app itself.');
    default:
        return error.message;
    }
}
