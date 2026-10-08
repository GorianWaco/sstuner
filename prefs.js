// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    MAX_PRESETS,
    SOUND_FACTORY,
    displayName,
    newPresetId,
    nextDefaultName,
    parsePresets,
    sanitizeName,
    serializePresets,
} from './presets.js';

function formatSound(preset) {
    const sign = v => (v > 0 ? `+${v}` : String(v));
    return _('Bass %s dB, mid %s dB, treble %s dB, spatial %s%%').format(
        sign(preset.bass), sign(preset.mid), sign(preset.treble), preset.spatial ?? 0);
}

export default class SstunerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: _('Sound')});

        const sound = new Adw.PreferencesGroup({
            title: _('Sound'),
            description: _('Equalizer and spatial sound via PipeWire. 0 = unchanged. Values are restored after login.'),
        });

        for (const [key, title, subtitle] of [
            ['eq-bass', _('Bass at startup'), _('Shelf ~120 Hz, range −12…+12 dB.')],
            ['eq-mid', _('Mid at startup'), _('Peak ~1 kHz, range −12…+12 dB.')],
            ['eq-treble', _('Treble at startup'), _('Shelf ~6 kHz, range −12…+12 dB.')],
        ]) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                adjustment: new Gtk.Adjustment({
                    lower: -12,
                    upper: 12,
                    step_increment: 1,
                    page_increment: 3,
                    value: settings.get_int(key),
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            sound.add(row);
        }

        const spatial = new Adw.SpinRow({
            title: _('Spatial sound at startup'),
            subtitle: _('0 = unchanged stereo, 100 = widest stage. Works in games too.'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('eq-spatial'),
            }),
        });
        settings.bind('eq-spatial', spatial, 'value', Gio.SettingsBindFlags.DEFAULT);
        sound.add(spatial);
        page.add(sound);

        this._addPresetGroup(page, settings, {
            title: _('Sound presets'),
            description: _('Click = load, + = save. Bass / mid / treble / spatial.'),
            listKey: 'sound-presets',
            activeKey: 'sound-preset-active',
            kind: 'sound',
            namePrefix: _('Sound'),
            factory: SOUND_FACTORY,
            format: formatSound,
            snapshot: () => ({
                bass: settings.get_int('eq-bass'),
                mid: settings.get_int('eq-mid'),
                treble: settings.get_int('eq-treble'),
                spatial: settings.get_int('eq-spatial'),
            }),
        });

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({
            title: _('Reset all sliders'),
            subtitle: _('Equalizer 0 dB, spatial sound 0%. Presets are kept.'),
        });
        const resetBtn = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
        });
        resetBtn.add_css_class('destructive-action');
        resetBtn.connect('clicked', () => {
            settings.set_int('eq-bass', 0);
            settings.set_int('eq-mid', 0);
            settings.set_int('eq-treble', 0);
            settings.set_int('eq-spatial', 0);
        });
        resetRow.add_suffix(resetBtn);
        reset.add(resetRow);
        page.add(reset);

        window.add(page);
        window.search_enabled = false;
        window.default_width = 560;
        window.default_height = 760;
    }

    _addPresetGroup(page, settings, spec) {
        const group = new Adw.PreferencesGroup({
            title: spec.title,
            description: spec.description,
        });
        const rows = [];

        const rebuild = () => {
            for (const row of rows)
                group.remove(row);
            rows.length = 0;

            const list = parsePresets(settings.get_string(spec.listKey), spec.kind);
            const active = settings.get_string(spec.activeKey);

            for (const preset of list) {
                const name = displayName(preset, _);
                const row = new Adw.EntryRow({
                    title: name,
                    text: name,
                    show_apply_button: true,
                });
                row.set_tooltip_text(spec.format(preset));
                if (preset.id === active)
                    row.add_css_class('success');

                row.connect('apply', () => {
                    const name = sanitizeName(row.text, displayName(preset, _));
                    const next = list.map(item => item.id === preset.id
                        ? {...item, name}
                        : item);
                    settings.set_string(spec.listKey, serializePresets(next));
                });

                const loadBtn = new Gtk.Button({
                    icon_name: 'document-open-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Load'),
                });
                loadBtn.add_css_class('flat');
                loadBtn.connect('clicked', () => {
                    if (spec.kind === 'sound') {
                        settings.set_int('eq-bass', preset.bass);
                        settings.set_int('eq-mid', preset.mid);
                        settings.set_int('eq-treble', preset.treble);
                        settings.set_int('eq-spatial', preset.spatial ?? 0);
                    } else {
                        settings.set_int('percent', preset.percent);
                        settings.set_int('contrast', preset.contrast);
                        settings.set_int('saturation', preset.saturation ?? 0);
                    }
                    settings.set_string(spec.activeKey, preset.id);
                });
                row.add_suffix(loadBtn);

                const saveBtn = new Gtk.Button({
                    icon_name: 'document-save-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Overwrite with current sliders'),
                });
                saveBtn.add_css_class('flat');
                saveBtn.connect('clicked', () => {
                    const next = list.map(item => item.id === preset.id
                        ? {...item, ...spec.snapshot()}
                        : item);
                    settings.set_string(spec.listKey, serializePresets(next));
                    settings.set_string(spec.activeKey, preset.id);
                });
                row.add_suffix(saveBtn);

                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Delete'),
                });
                delBtn.add_css_class('flat');
                delBtn.connect('clicked', () => {
                    const next = list.filter(item => item.id !== preset.id);
                    if (settings.get_string(spec.activeKey) === preset.id)
                        settings.set_string(spec.activeKey, '');
                    settings.set_string(spec.listKey, serializePresets(next));
                });
                row.add_suffix(delBtn);

                group.add(row);
                rows.push(row);
            }

            const addRow = new Adw.ActionRow({
                title: _('Save current sliders as a new preset'),
                subtitle: list.length >= MAX_PRESETS
                    ? _('Limit of %d presets reached.').format(MAX_PRESETS)
                    : _('Will be saved as “%s”.').format(nextDefaultName(list, spec.namePrefix)),
            });
            const addBtn = new Gtk.Button({
                label: _('Add'),
                valign: Gtk.Align.CENTER,
                sensitive: list.length < MAX_PRESETS,
            });
            addBtn.add_css_class('suggested-action');
            addBtn.connect('clicked', () => {
                const current = parsePresets(settings.get_string(spec.listKey), spec.kind);
                if (current.length >= MAX_PRESETS)
                    return;
                const preset = {
                    id: newPresetId(spec.kind === 'sound' ? 's' : 'p'),
                    name: nextDefaultName(current, spec.namePrefix),
                    ...spec.snapshot(),
                };
                settings.set_string(spec.listKey, serializePresets([...current, preset]));
                settings.set_string(spec.activeKey, preset.id);
            });
            addRow.add_suffix(addBtn);
            group.add(addRow);
            rows.push(addRow);

            const factoryRow = new Adw.ActionRow({
                title: _('Restore factory presets'),
                subtitle: _('Adds the missing ones (Bass, Voice, Spatial…). Your own presets are kept.'),
            });
            const factoryBtn = new Gtk.Button({
                label: _('Restore'),
                valign: Gtk.Align.CENTER,
            });
            factoryBtn.connect('clicked', () => {
                const current = parsePresets(settings.get_string(spec.listKey), spec.kind);
                const have = new Set(current.map(item => item.id));
                const merged = [...current];
                for (const item of spec.factory) {
                    if (have.has(item.id) || merged.length >= MAX_PRESETS)
                        continue;
                    merged.push(item);
                }
                settings.set_string(spec.listKey, serializePresets(merged));
            });
            factoryRow.add_suffix(factoryBtn);
            group.add(factoryRow);
            rows.push(factoryRow);
        };

        settings.connect(`changed::${spec.listKey}`, rebuild);
        settings.connect(`changed::${spec.activeKey}`, rebuild);
        rebuild();
        page.add(group);
    }
}
