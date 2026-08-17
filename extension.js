// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickSettingsItem, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {
    MAX_PRESETS,
    findMatching,
    newPresetId,
    nextDefaultName,
    parsePresets,
    sanitizeName,
    serializePresets,
} from './presets.js';

const MIN_EQ = -12;
const MAX_EQ = 12;
const MIN_SPATIAL = 0;
const MAX_SPATIAL = 100;
const EQ_DEBOUNCE_MS = 40;
const EQ_NODE_NAME = 'sstuner.eq';
const SPATIAL_NODE_NAME = 'sstuner.spatial';
const SPATIAL_WET = 0.35;
const SPATIAL_DELAY_L = 0.011;
const SPATIAL_DELAY_R = 0.016;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(Number(value) || 0)));
}

function clampEq(value) {
    return clamp(value, MIN_EQ, MAX_EQ);
}

function clampSpatial(value) {
    return clamp(value, MIN_SPATIAL, MAX_SPATIAL);
}

function spatialParams(amount) {
    const t = clampSpatial(amount) / MAX_SPATIAL;
    return {
        wet: t * SPATIAL_WET,
        delayL: t * SPATIAL_DELAY_L,
        delayR: t * SPATIAL_DELAY_R,
    };
}

function sliderFromRange(value, min, max) {
    return (clamp(value, min, max) - min) / (max - min);
}

function valueFromSlider(sliderValue, min, max) {
    return clamp(min + sliderValue * (max - min), min, max);
}

function markPos(value, min, max) {
    return (value - min) / (max - min);
}

function formatSigned(value) {
    if (value > 0)
        return `+${value}`;
    if (value < 0)
        return `−${Math.abs(value)}`;
    return '0';
}

function spaFloat(value) {
    const n = Number(value) || 0;
    return Number.isInteger(n) ? `${n}.0` : String(n);
}

/**
 * Podziałka z jawnej listy wartości. Siedzi w kodzie, więc wraca
 * po przelogowaniu — nie zależy od sesji ani gsettings.
 */
function buildScale(min, max, values) {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    const marks = [];
    for (const value of sorted) {
        const pos = markPos(value, min, max);
        const major = value === min || value === max || value === 0 || value === 100;
        marks.push({
            pos,
            label: String(value),
            major,
        });
    }
    return {marks};
}

function findDdcutil() {
    const home = GLib.get_home_dir();
    for (const path of [`${home}/.local/bin/ddcutil`, '/usr/bin/ddcutil', '/usr/local/bin/ddcutil']) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return null;
}

function spawnCapture(argv) {
    try {
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        const [, stdout, stderr] = proc.communicate_utf8(null, null);
        return `${stdout ?? ''}${stderr ?? ''}`;
    } catch {
        return '';
    }
}

function spawnQuiet(argv) {
    try {
        const proc = Gio.Subprocess.new(
            argv,
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        proc.wait_check_async(null, () => {});
        return true;
    } catch {
        return false;
    }
}

function findNodeId(name) {
    const out = spawnCapture(['pw-cli', 'i', name]);
    const match = out.match(/^\s*id:\s*(\d+)/m);
    return match ? Number(match[1]) : 0;
}

function stripLegacyPictureEffects() {
    const names = ['sstuner', 'sstuner-sat'];
    const actors = [];
    try {
        if (global.window_group)
            actors.push(global.window_group);
        for (const actor of global.get_window_actors())
            actors.push(actor);
    } catch {
        // compositor not ready
    }
    for (const actor of actors) {
        try {
            for (const name of names) {
                const existing = actor.get_effect(name);
                if (existing)
                    actor.remove_effect(existing);
            }
        } catch {
            // actor gone
        }
    }
}

function restoreMonitorBacklight() {
    const ddcutil = findDdcutil();
    if (!ddcutil)
        return;
    const out = spawnCapture([ddcutil, 'detect', '--brief']);
    const match = out.match(/I2C bus:\s*\/dev\/i2c-(\d+)/i);
    if (!match)
        return;
    spawnQuiet([
        ddcutil, 'setvcp', '10', '100',
        '--bus', match[1],
        '--noverify',
    ]);
}


class EqController {
    constructor(settings, extPath) {
        this._settings = settings;
        this._extPath = extPath;
        this._proc = null;
        this._nodeId = 0;
        this._spatialId = 0;
        this._timeout = 0;
        this._waitId = 0;
        this._retryId = 0;
        this._retries = 0;
        this._starting = false;
        this._settingIds = ['eq-bass', 'eq-mid', 'eq-treble', 'eq-spatial'].map(key =>
            this._settings.connect(`changed::${key}`, () => this.apply()));
    }

    get bass() {
        return clampEq(this._settings.get_int('eq-bass'));
    }

    get mid() {
        return clampEq(this._settings.get_int('eq-mid'));
    }

    get treble() {
        return clampEq(this._settings.get_int('eq-treble'));
    }

    get spatial() {
        return clampSpatial(this._settings.get_int('eq-spatial'));
    }

    setBass(value) {
        const next = clampEq(value);
        if (next === this.bass)
            this.apply();
        else
            this._settings.set_int('eq-bass', next);
    }

    setMid(value) {
        const next = clampEq(value);
        if (next === this.mid)
            this.apply();
        else
            this._settings.set_int('eq-mid', next);
    }

    setTreble(value) {
        const next = clampEq(value);
        if (next === this.treble)
            this.apply();
        else
            this._settings.set_int('eq-treble', next);
    }

    setSpatial(value) {
        const next = clampSpatial(value);
        if (next === this.spatial)
            this.apply();
        else
            this._settings.set_int('eq-spatial', next);
    }

    resetAll() {
        this._settings.set_int('eq-bass', 0);
        this._settings.set_int('eq-mid', 0);
        this._settings.set_int('eq-treble', 0);
        this._settings.set_int('eq-spatial', 0);
    }

    snapshot() {
        return {
            bass: this.bass,
            mid: this.mid,
            treble: this.treble,
            spatial: this.spatial,
        };
    }

    applyPreset(preset) {
        this._settings.set_int('eq-bass', clampEq(preset.bass));
        this._settings.set_int('eq-mid', clampEq(preset.mid));
        this._settings.set_int('eq-treble', clampEq(preset.treble));
        this._settings.set_int('eq-spatial', clampSpatial(preset.spatial ?? 0));
    }

    start() {
        this._nodeId = findNodeId(EQ_NODE_NAME);
        this._spatialId = findNodeId(SPATIAL_NODE_NAME);
        if (this._nodeId) {
            this._sendGains();
            return;
        }
        if (this._starting)
            return;
        if (this._proc && !this._hasExited(this._proc))
            return;

        const conf = GLib.build_filenamev([this._extPath, 'eq.conf']);
        if (!GLib.file_test(conf, GLib.FileTest.IS_REGULAR))
            return;
        if (!GLib.find_program_in_path('pipewire') || !GLib.find_program_in_path('pw-cli'))
            return;

        try {
            this._proc = Gio.Subprocess.new(
                ['pipewire', '-c', conf],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch {
            this._proc = null;
            this._scheduleRetry();
            return;
        }

        this._starting = true;
        let tries = 0;
        this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._nodeId = findNodeId(EQ_NODE_NAME);
            this._spatialId = findNodeId(SPATIAL_NODE_NAME);
            if (this._nodeId) {
                this._starting = false;
                this._retries = 0;
                this._waitId = 0;
                this._sendGains();
                return GLib.SOURCE_REMOVE;
            }
            if (++tries >= 20) {
                this._starting = false;
                this._waitId = 0;
                this._scheduleRetry();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    apply() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_DEBOUNCE_MS, () => {
            this._timeout = 0;
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendGains() {
        if (this._nodeId) {
            const args = `{ params = [ "bass:Gain" ${spaFloat(this.bass)} "mid:Gain" ${spaFloat(this.mid)} "treble:Gain" ${spaFloat(this.treble)} ] }`;
            spawnQuiet(['pw-cli', 's', String(this._nodeId), 'Props', args]);
        }
        if (this._spatialId) {
            const p = spatialParams(this.spatial);
            const args = `{ params = [ "mixL:Gain 2" ${spaFloat(p.wet)} "mixR:Gain 2" ${spaFloat(p.wet)} "delayL:Delay (s)" ${spaFloat(p.delayL)} "delayR:Delay (s)" ${spaFloat(p.delayR)} ] }`;
            spawnQuiet(['pw-cli', 's', String(this._spatialId), 'Props', args]);
        }
    }

    _flush() {
        this._nodeId = findNodeId(EQ_NODE_NAME);
        this._spatialId = findNodeId(SPATIAL_NODE_NAME);
        if (!this._nodeId) {
            this.start();
            return;
        }
        this._sendGains();
    }

    _hasExited(proc) {
        try {
            return proc.get_if_exited();
        } catch {
            return true;
        }
    }

    _scheduleRetry() {
        if (this._retryId || this._retries >= 5)
            return;
        this._retries += 1;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._retryId = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        this._starting = false;
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        if (this._waitId) {
            GLib.source_remove(this._waitId);
            this._waitId = 0;
        }
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch {
                // already gone
            }
            this._proc = null;
        }
        this._nodeId = 0;
        this._spatialId = 0;
    }

    destroy() {
        for (const id of this._settingIds)
            this._settings.disconnect(id);
        this._settingIds = [];
        this.stop();
    }
}

const FineSlider = GObject.registerClass(
class FineSlider extends Slider {
    _init(value, unitStep) {
        super._init(value);
        this._unitStep = unitStep;
    }

    _quantize(value) {
        const step = this._unitStep || 0.01;
        return Math.clamp(Math.round(value / step) * step, 0, 1);
    }

    _applyDelta(delta) {
        const base = this._unsnappedValue ?? this._value;
        const oldValue = this._value;
        const raw = Math.clamp(base + delta, 0, this._maxValue);
        this._unsnappedValue = raw;
        this.value = this._quantize(raw);
        return this._value !== oldValue;
    }

    step(nSteps) {
        return this._applyDelta(nSteps * this._unitStep);
    }

    _moveHandle(x, y) {
        super._moveHandle(x, y);
        const q = this._quantize(this.value);
        if (q !== this.value)
            this.value = q;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        const left = key === Clutter.KEY_Left || key === Clutter.KEY_Down;
        const right = key === Clutter.KEY_Right || key === Clutter.KEY_Up;
        if (left || right) {
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
            let increase = right;
            if (rtl && (key === Clutter.KEY_Left || key === Clutter.KEY_Right))
                increase = !increase;
            this.step(increase ? 1 : -1);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }

    _getMinimumIncrement() {
        return this._unitStep;
    }
});

const TickBar = GObject.registerClass(
class TickBar extends St.Widget {
    _init(marks) {
        super._init({
            style_class: 'sstuner-ticks',
            x_expand: true,
            y_expand: false,
        });
        this._marks = [];
        for (const mark of marks) {
            const line = new St.Widget({
                style_class: mark.major
                    ? 'sstuner-tick-line sstuner-tick-line-major'
                    : 'sstuner-tick-line',
            });
            const label = new St.Label({
                text: mark.label,
                style_class: mark.major ? 'sstuner-tick sstuner-tick-major' : 'sstuner-tick',
            });
            this.add_child(line);
            this.add_child(label);
            this._marks.push({
                line,
                label,
                pos: mark.pos,
                major: !!mark.major,
            });
        }
    }

    vfunc_get_preferred_height(_forWidth) {
        let min = 14;
        let nat = 14;
        for (const {label} of this._marks) {
            const [cmin, cnat] = label.get_preferred_height(-1);
            min = Math.max(min, cmin + 5);
            nat = Math.max(nat, cnat + 5);
        }
        return [min, nat];
    }

    vfunc_get_preferred_width(_forHeight) {
        return [40, 120];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const themeNode = this.get_theme_node();
        const content = themeNode.get_content_box(box);
        const width = Math.max(1, content.x2 - content.x1);
        const height = Math.max(1, content.y2 - content.y1);
        const childBox = new Clutter.ActorBox();
        const lineH = Math.max(3, Math.round(height * 0.28));

        const labelRects = [];
        for (const mark of this._marks) {
            const xCenter = content.x1 + mark.pos * width;
            const lineW = mark.major ? 2 : 1;
            childBox.set_origin(Math.round(xCenter - lineW / 2), content.y1);
            childBox.set_size(lineW, lineH);
            mark.line.allocate(childBox);

            const [, natW] = mark.label.get_preferred_width(-1);
            const [, natH] = mark.label.get_preferred_height(-1);
            let x = xCenter - natW / 2;
            x = Math.max(content.x1, Math.min(content.x2 - natW, x));
            const y = content.y1 + lineH + 1;
            labelRects.push({
                mark,
                x,
                y,
                w: Math.max(1, Math.ceil(natW)),
                h: Math.max(1, Math.ceil(natH)),
            });
        }

        const shown = [];
        const overlaps = (a, b) =>
            !(a.x + a.w + 2 <= b.x || b.x + b.w + 2 <= a.x);

        for (const rect of labelRects.filter(r => r.mark.major)) {
            rect.mark.label.visible = true;
            childBox.set_origin(Math.round(rect.x), Math.round(rect.y));
            childBox.set_size(rect.w, rect.h);
            rect.mark.label.allocate(childBox);
            shown.push(rect);
        }
        for (const rect of labelRects.filter(r => !r.mark.major)) {
            const clash = shown.some(s => overlaps(rect, s));
            if (clash) {
                rect.mark.label.visible = false;
                childBox.set_origin(0, 0);
                childBox.set_size(1, 1);
                rect.mark.label.allocate(childBox);
                continue;
            }
            rect.mark.label.visible = true;
            childBox.set_origin(Math.round(rect.x), Math.round(rect.y));
            childBox.set_size(rect.w, rect.h);
            rect.mark.label.allocate(childBox);
            shown.push(rect);
        }
    }
});

const ScaleRow = GObject.registerClass(
class ScaleRow extends St.BoxLayout {
    _init({
        iconName,
        iconLabel,
        accessibleName,
        marks,
        min,
        max,
        onChange,
        onReset,
    }) {
        super._init({
            style_class: 'sstuner-row',
            x_expand: true,
        });

        this._onChange = onChange;
        this._changing = false;
        this._min = min;
        this._max = max;
        const span = Math.max(1, max - min);
        const unitStep = 1 / span;

        this._iconButton = new St.Button({
            child: new St.Icon({icon_name: iconName}),
            style_class: 'icon-button flat',
            can_focus: true,
            x_expand: false,
            y_expand: true,
            accessible_name: iconLabel,
        });
        this._iconButton.connect('clicked', () => onReset?.());
        this.add_child(this._iconButton);

        const mid = new St.BoxLayout({
            style_class: 'sstuner-mid',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.slider = new FineSlider(0, unitStep);
        this.slider.accessible_name = accessibleName;

        this._sliderId = this.slider.connect('notify::value', () => {
            if (this._changing)
                return;
            this._onChange(this.slider.value);
        });

        const sliderBin = new St.Bin({
            style_class: 'slider-bin',
            child: this.slider,
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        sliderBin.connect('event', (_bin, event) => this.slider.event(event, false));

        const slideRow = new St.BoxLayout({
            style_class: 'sstuner-slide',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._minus = this._makeStepButton('−', `Zmniejsz ${accessibleName}`, -1);
        this._plus = this._makeStepButton('+', `Zwiększ ${accessibleName}`, 1);
        slideRow.add_child(this._minus);
        slideRow.add_child(sliderBin);
        slideRow.add_child(this._plus);
        mid.add_child(slideRow);
        mid.add_child(new TickBar(marks));
        this.add_child(mid);

        this._value = new St.Label({
            text: '',
            style_class: 'sstuner-value',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });
        this.add_child(this._value);

        this.connect('destroy', () => {
            if (this._sliderId)
                this.slider.disconnect(this._sliderId);
            this._sliderId = 0;
            this._stopStep();
        });
    }

    _makeStepButton(label, name, delta) {
        const btn = new St.Button({
            label,
            style_class: 'sstuner-step',
            can_focus: true,
            x_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: name,
        });
        let holdId = 0;
        let repeatId = 0;
        let repeating = false;
        const stop = () => {
            if (holdId) {
                GLib.source_remove(holdId);
                holdId = 0;
            }
            if (repeatId) {
                GLib.source_remove(repeatId);
                repeatId = 0;
            }
        };
        btn.connect('clicked', () => {
            if (repeating) {
                repeating = false;
                return;
            }
            this._nudge(delta);
        });
        btn.connect('button-press-event', () => {
            stop();
            repeating = false;
            holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 380, () => {
                holdId = 0;
                repeating = true;
                this._nudge(delta);
                repeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 90, () => {
                    this._nudge(delta);
                    return GLib.SOURCE_CONTINUE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('button-release-event', () => {
            stop();
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('leave-event', () => {
            stop();
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('destroy', stop);
        if (!this._stepStops)
            this._stepStops = [];
        this._stepStops.push(stop);
        return btn;
    }

    _stopStep() {
        for (const stop of this._stepStops ?? [])
            stop();
        this._stepStops = [];
    }

    _nudge(delta) {
        const current = valueFromSlider(this.slider.value, this._min, this._max);
        const next = clamp(current + delta, this._min, this._max);
        if (next === current)
            return;
        this._onChange(sliderFromRange(next, this._min, this._max));
    }

    setState(sliderValue, label, changed) {
        this._changing = true;
        this.slider.value = sliderValue;
        this._changing = false;
        this._value.text = label;
        if (changed)
            this._value.add_style_class_name('sstuner-value-changed');
        else
            this._value.remove_style_class_name('sstuner-value-changed');

        const value = valueFromSlider(sliderValue, this._min, this._max);
        this._minus.reactive = value > this._min;
        this._minus.opacity = value > this._min ? 255 : 80;
        this._plus.reactive = value < this._max;
        this._plus.opacity = value < this._max ? 255 : 80;
    }
});

const PresetBar = GObject.registerClass(
class PresetBar extends St.BoxLayout {
    _init({
        settings,
        listKey,
        activeKey,
        kind,
        namePrefix,
        snapshot,
        applyPreset,
    }) {
        super._init({
            style_class: 'sstuner-preset-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._settings = settings;
        this._listKey = listKey;
        this._activeKey = activeKey;
        this._kind = kind;
        this._namePrefix = namePrefix;
        this._snapshot = snapshot;
        this._applyPreset = applyPreset;
        this._menu = null;
        this._editing = null;

        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this._scroll = new St.ScrollView({
            style_class: 'sstuner-preset-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        this._chipBox = new St.BoxLayout({
            style_class: 'sstuner-preset-chips',
            x_expand: true,
        });
        if (this._scroll.set_child)
            this._scroll.set_child(this._chipBox);
        else
            this._scroll.add_actor(this._chipBox);
        this.add_child(this._scroll);

        this._addBtn = new St.Button({
            style_class: 'icon-button flat sstuner-preset-add',
            can_focus: true,
            x_expand: false,
            accessible_name: `Zapisz preset ${namePrefix.toLowerCase()}`,
        });
        this._addBtn.child = new St.Icon({icon_name: 'list-add-symbolic'});
        this._addBtn.connect('clicked', () => this._beginSave());
        this.add_child(this._addBtn);

        this._editor = new St.BoxLayout({
            style_class: 'sstuner-preset-editor',
            x_expand: true,
            visible: false,
        });
        this._entry = new St.Entry({
            style_class: 'sstuner-preset-entry',
            hint_text: 'Nazwa presetu',
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._commitEditor());
        const ok = new St.Button({
            style_class: 'icon-button flat',
            child: new St.Icon({icon_name: 'object-select-symbolic'}),
            accessible_name: 'Zapisz nazwę',
        });
        ok.connect('clicked', () => this._commitEditor());
        const cancel = new St.Button({
            style_class: 'icon-button flat',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            accessible_name: 'Anuluj',
        });
        cancel.connect('clicked', () => this._hideEditor());
        this._editor.add_child(this._entry);
        this._editor.add_child(ok);
        this._editor.add_child(cancel);
        this.add_child(this._editor);

        this._ids = [listKey, activeKey].map(key =>
            settings.connect(`changed::${key}`, () => this._rebuild()));
        this.connect('destroy', () => {
            this._closeMenu();
            for (const id of this._ids)
                this._settings.disconnect(id);
            this._ids = [];
        });
        this._rebuild();
    }

    refreshActive() {
        const match = findMatching(this._list(), this._snapshot(), this._kind);
        const id = match?.id ?? '';
        if (this._settings.get_string(this._activeKey) !== id)
            this._settings.set_string(this._activeKey, id);
    }

    _list() {
        return parsePresets(this._settings.get_string(this._listKey), this._kind);
    }

    _write(list) {
        this._settings.set_string(this._listKey, serializePresets(list));
    }

    _rebuild() {
        this._chipBox.destroy_all_children();
        const list = this._list();
        const active = this._settings.get_string(this._activeKey);
        for (const preset of list) {
            const chip = new St.Button({
                label: preset.name,
                style_class: preset.id === active
                    ? 'sstuner-preset-chip sstuner-preset-chip-active'
                    : 'sstuner-preset-chip',
                can_focus: true,
                x_expand: false,
                accessible_name: `Wczytaj preset ${preset.name}`,
            });
            chip.connect('clicked', () => this._load(preset));
            chip.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 3) {
                    this._openMenu(chip, preset);
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._chipBox.add_child(chip);
        }
        this._addBtn.reactive = list.length < MAX_PRESETS;
        this._addBtn.opacity = list.length < MAX_PRESETS ? 255 : 90;
    }

    _load(preset) {
        this._hideEditor();
        this._applyPreset(preset);
        this._settings.set_string(this._activeKey, preset.id);
    }

    _beginSave(existing = null) {
        const list = this._list();
        if (!existing && list.length >= MAX_PRESETS)
            return;
        this._editing = existing;
        this._entry.set_text(existing?.name ?? nextDefaultName(list, this._namePrefix));
        this._scroll.visible = false;
        this._addBtn.visible = false;
        this._editor.visible = true;
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_selection(0, -1);
    }

    _hideEditor() {
        this._editing = null;
        this._editor.visible = false;
        this._scroll.visible = true;
        this._addBtn.visible = true;
    }

    _commitEditor() {
        const list = this._list();
        const fallback = this._editing?.name ?? nextDefaultName(list, this._namePrefix);
        const name = sanitizeName(this._entry.get_text(), fallback);
        const snap = this._snapshot();

        if (this._editing) {
            const next = list.map(preset => preset.id === this._editing.id
                ? {...preset, name}
                : preset);
            this._write(next);
            this._settings.set_string(this._activeKey, this._editing.id);
        } else {
            const sameName = list.find(preset =>
                preset.name.toLowerCase() === name.toLowerCase());
            if (sameName) {
                const next = list.map(preset => preset.id === sameName.id
                    ? {...sameName, ...snap, name}
                    : preset);
                this._write(next);
                this._settings.set_string(this._activeKey, sameName.id);
            } else if (list.length < MAX_PRESETS) {
                const preset = {
                    id: newPresetId(this._kind === 'sound' ? 's' : 'p'),
                    name,
                    ...snap,
                };
                this._write([...list, preset]);
                this._settings.set_string(this._activeKey, preset.id);
            }
        }
        this._hideEditor();
    }

    _overwrite(preset) {
        const snap = this._snapshot();
        const next = this._list().map(item => item.id === preset.id
            ? {...item, ...snap}
            : item);
        this._write(next);
        this._settings.set_string(this._activeKey, preset.id);
    }

    _remove(id) {
        const next = this._list().filter(preset => preset.id !== id);
        if (this._settings.get_string(this._activeKey) === id)
            this._settings.set_string(this._activeKey, '');
        this._write(next);
    }

    _openMenu(source, preset) {
        this._closeMenu();
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.BOTTOM);
        menu.addAction('Nadpisz bieżącymi', () => this._overwrite(preset));
        menu.addAction('Zmień nazwę', () => this._beginSave(preset));
        menu.addAction('Usuń', () => this._remove(preset.id));

        const actor = menu.actor ?? menu;
        Main.uiGroup.add_child(actor);
        this._menuManager.addMenu(menu);
        menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                this._closeMenu();
        });
        this._menu = menu;
        menu.open();
    }

    _closeMenu() {
        if (!this._menu)
            return;
        const menu = this._menu;
        this._menu = null;
        try {
            this._menuManager.removeMenu(menu);
        } catch {
            // already gone
        }
        try {
            menu.destroy();
        } catch {
            // already gone
        }
    }
});

const FoldSection = GObject.registerClass(
class FoldSection extends St.BoxLayout {
    _init({title, settings, key, summary}) {
        super._init({
            style_class: 'sstuner-fold',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._settings = settings;
        this._key = key;
        this._summary = summary;

        this._header = new St.Button({
            style_class: 'sstuner-fold-header',
            x_expand: true,
            can_focus: true,
            toggle_mode: true,
            accessible_name: title,
        });
        const head = new St.BoxLayout({
            style_class: 'sstuner-fold-head',
            x_expand: true,
        });
        this._chevron = new St.Icon({
            icon_name: 'pan-down-symbolic',
            style_class: 'popup-menu-icon sstuner-fold-chevron',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({
            text: title,
            style_class: 'sstuner-eq-title sstuner-fold-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._hint = new St.Label({
            text: '',
            style_class: 'sstuner-fold-hint',
            y_align: Clutter.ActorAlign.CENTER,
        });
        head.add_child(this._chevron);
        head.add_child(this._title);
        head.add_child(this._hint);
        this._header.set_child(head);
        this._header.connect('clicked', () => {
            this._settings.set_boolean(this._key, !this._settings.get_boolean(this._key));
        });
        this.add_child(this._header);

        this.body = new St.BoxLayout({
            style_class: 'sstuner-fold-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(this.body);

        this._id = settings.connect(`changed::${key}`, () => this._apply());
        this.connect('destroy', () => {
            if (this._id)
                this._settings.disconnect(this._id);
            this._id = 0;
        });
        this._apply();
    }

    refreshHint() {
        if (!this._hint.visible)
            return;
        this._hint.text = this._summary?.() ?? '';
    }

    _apply() {
        const open = this._settings.get_boolean(this._key);
        this.body.visible = open;
        this._hint.visible = !open;
        this._chevron.icon_name = open ? 'pan-down-symbolic' : 'pan-end-symbolic';
        this._header.checked = open;
        this.refreshHint();
    }
});

const AdjustPanel = GObject.registerClass(
class AdjustPanel extends QuickSettingsItem {
    _init(extension) {
        super._init({
            style_class: 'quick-slider sstuner-panel',
            can_focus: false,
            reactive: false,
            x_expand: true,
        });

        this._extension = extension;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'sstuner-panel',
        });
        this.set_child(box);

        this._soundFold = new FoldSection({
            title: 'Dźwięk',
            settings: extension.settings,
            key: 'sound-expanded',
            summary: () => this._soundHint(),
        });
        box.add_child(this._soundFold);

        const eqScale = buildScale(MIN_EQ, MAX_EQ, [-12, -6, 0, 6, 12]);
        const eqMarks = eqScale.marks.map(mark => ({
            ...mark,
            label: formatSigned(Number(mark.label)),
        }));

        this._eqBass = new ScaleRow({
            iconName: 'audio-speakers-symbolic',
            iconLabel: 'Przywróć bas 0 dB',
            accessibleName: 'Equalizer bas',
            marks: eqMarks,
            min: MIN_EQ,
            max: MAX_EQ,
            onChange: value => extension.eq?.setBass(
                valueFromSlider(value, MIN_EQ, MAX_EQ)),
            onReset: () => extension.eq?.setBass(0),
        });
        this._soundFold.body.add_child(this._eqBass);

        this._eqMid = new ScaleRow({
            iconName: 'audio-volume-medium-symbolic',
            iconLabel: 'Przywróć średnie 0 dB',
            accessibleName: 'Equalizer średnie',
            marks: eqMarks,
            min: MIN_EQ,
            max: MAX_EQ,
            onChange: value => extension.eq?.setMid(
                valueFromSlider(value, MIN_EQ, MAX_EQ)),
            onReset: () => extension.eq?.setMid(0),
        });
        this._soundFold.body.add_child(this._eqMid);

        this._eqTreble = new ScaleRow({
            iconName: 'audio-volume-high-symbolic',
            iconLabel: 'Przywróć sopran 0 dB',
            accessibleName: 'Equalizer sopran',
            marks: eqMarks,
            min: MIN_EQ,
            max: MAX_EQ,
            onChange: value => extension.eq?.setTreble(
                valueFromSlider(value, MIN_EQ, MAX_EQ)),
            onReset: () => extension.eq?.setTreble(0),
        });
        this._soundFold.body.add_child(this._eqTreble);

        const spatial = buildScale(MIN_SPATIAL, MAX_SPATIAL, [0, 25, 50, 75, 100]);
        this._eqSpatial = new ScaleRow({
            iconName: 'audio-headphones-symbolic',
            iconLabel: 'Przywróć przestrzeń 0%',
            accessibleName: 'Dźwięk przestrzenny',
            marks: spatial.marks.map(mark => {
                if (mark.pos === 0)
                    return {...mark, label: 'off'};
                return mark;
            }),
            min: MIN_SPATIAL,
            max: MAX_SPATIAL,
            onChange: value => extension.eq?.setSpatial(
                valueFromSlider(value, MIN_SPATIAL, MAX_SPATIAL)),
            onReset: () => extension.eq?.setSpatial(0),
        });
        this._soundFold.body.add_child(this._eqSpatial);

        this._soundPresets = new PresetBar({
            settings: extension.settings,
            listKey: 'sound-presets',
            activeKey: 'sound-preset-active',
            kind: 'sound',
            namePrefix: 'Dźwięk',
            snapshot: () => extension.eq?.snapshot() ?? {
                bass: 0, mid: 0, treble: 0, spatial: 0,
            },
            applyPreset: preset => extension.eq?.applyPreset(preset),
        });
        this._soundFold.body.add_child(this._soundPresets);

        const keys = ['eq-bass', 'eq-mid', 'eq-treble', 'eq-spatial'];
        this._ids = keys.map(key =>
            extension.settings.connect(`changed::${key}`, () => this._sync()));
        this.connect('destroy', () => {
            for (const id of this._ids)
                this._extension.settings.disconnect(id);
            this._ids = [];
        });
        this._sync();
    }

    _sync() {
        const eq = this._extension.eq;
        if (!eq)
            return;
        this._eqBass.setState(
            sliderFromRange(eq.bass, MIN_EQ, MAX_EQ),
            `${formatSigned(eq.bass)} dB`,
            eq.bass !== 0);
        this._eqMid.setState(
            sliderFromRange(eq.mid, MIN_EQ, MAX_EQ),
            `${formatSigned(eq.mid)} dB`,
            eq.mid !== 0);
        this._eqTreble.setState(
            sliderFromRange(eq.treble, MIN_EQ, MAX_EQ),
            `${formatSigned(eq.treble)} dB`,
            eq.treble !== 0);
        this._eqSpatial.setState(
            sliderFromRange(eq.spatial, MIN_SPATIAL, MAX_SPATIAL),
            `${eq.spatial}%`,
            eq.spatial !== 0);

        this._soundPresets?.refreshActive();
        this._soundFold?.refreshHint();
    }

    _soundHint() {
        const eq = this._extension.eq;
        if (!eq)
            return '';
        return `${formatSigned(eq.bass)} / ${formatSigned(eq.mid)} / ${formatSigned(eq.treble)} dB  ·  ${eq.spatial}%`;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init(extension) {
        super._init();
        this.quickSettingsItems.push(new AdjustPanel(extension));
    }
});

export default class SstunerExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        stripLegacyPictureEffects();
        this.settings.set_int('percent', 100);
        this.settings.set_int('contrast', 0);
        this.settings.set_int('saturation', 0);
        restoreMonitorBacklight();

        this.eq = new EqController(this.settings, this.path);
        this.eq.start();

        this._indicator = new Indicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator, 2);
    }

    disable() {
        this._indicator?.quickSettingsItems.forEach(item => item.destroy());
        this._indicator?.destroy();
        this._indicator = null;

        this.eq?.destroy();
        this.eq = null;
        this.settings = null;
    }
}
