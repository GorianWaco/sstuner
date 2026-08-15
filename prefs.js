// SPDX-License-Identifier: GPL-2.0-or-later
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/prefs.js';
import {
    MAX_PRESETS,
    PICTURE_FACTORY,
    SOUND_FACTORY,
    newPresetId,
    nextDefaultName,
    parsePresets,
    sanitizeName,
    serializePresets,
} from './presets.js';

function formatPicture(preset) {
    return `Jasność ${preset.percent}%, kontrast ${preset.contrast}, temp. ${preset.temperature}, nasyc. ${preset.saturation}`;
}

function formatSound(preset) {
    const sign = v => (v > 0 ? `+${v}` : String(v));
    return `Bas ${sign(preset.bass)} dB, średnie ${sign(preset.mid)} dB, sopran ${sign(preset.treble)} dB`;
}

export default class SstunerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Obraz i dźwięk'});

        const behave = new Adw.PreferencesGroup({
            title: 'Jasność',
            description: '10–100% to podświetlenie monitora (DDC). Powyżej 100% obraz jest rozjaśniany programowo. Kliknięcie ikony suwaka przywraca wartość zerową.',
        });

        const ddc = new Adw.SwitchRow({
            title: 'Steruj monitorem przez DDC/CI',
            subtitle: 'Wymaga ddcutil. Wyłącz, jeśli chcesz tylko korekcję programową.',
        });
        settings.bind('use-ddc', ddc, 'active', Gio.SettingsBindFlags.DEFAULT);
        behave.add(ddc);

        const percent = new Adw.SpinRow({
            title: 'Jasność po starcie',
            subtitle: '100 = bez zmian. Mniej = ciemniej, więcej = jaśniej.',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 180,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('percent'),
            }),
        });
        settings.bind('percent', percent, 'value', Gio.SettingsBindFlags.DEFAULT);
        behave.add(percent);
        page.add(behave);

        const picture = new Adw.PreferencesGroup({
            title: 'Korekcja obrazu',
            description: 'Kontrast, temperatura i nasycenie działają zawsze programowo, niezależnie od DDC.',
        });

        const contrast = new Adw.SpinRow({
            title: 'Kontrast po starcie',
            subtitle: '0 = bez zmian. Ujemne spłaszcza, dodatnie wzmacnia.',
            adjustment: new Gtk.Adjustment({
                lower: -50,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('contrast'),
            }),
        });
        settings.bind('contrast', contrast, 'value', Gio.SettingsBindFlags.DEFAULT);
        picture.add(contrast);

        const temperature = new Adw.SpinRow({
            title: 'Temperatura po starcie',
            subtitle: 'Ujemne = zimny (niebieski), 0 = neutralny, dodatnie = ciepły.',
            adjustment: new Gtk.Adjustment({
                lower: -100,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: settings.get_int('temperature'),
            }),
        });
        settings.bind('temperature', temperature, 'value', Gio.SettingsBindFlags.DEFAULT);
        picture.add(temperature);

        const saturation = new Adw.SpinRow({
            title: 'Nasycenie po starcie',
            subtitle: 'Ujemne = szary, 0 = bez zmian, dodatnie = żywsze kolory.',
            adjustment: new Gtk.Adjustment({
                lower: -50,
                upper: 50,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('saturation'),
            }),
        });
        settings.bind('saturation', saturation, 'value', Gio.SettingsBindFlags.DEFAULT);
        picture.add(saturation);
        page.add(picture);

        const sound = new Adw.PreferencesGroup({
            title: 'Equalizer',
            description: 'Trzy pasma przez PipeWire. 0 dB = bez zmian. Wartości wracają po zalogowaniu.',
        });

        for (const [key, title, subtitle] of [
            ['eq-bass', 'Bas po starcie', 'Półka ~120 Hz, zakres −12…+12 dB.'],
            ['eq-mid', 'Średnie po starcie', 'Szczyt ~1 kHz, zakres −12…+12 dB.'],
            ['eq-treble', 'Sopran po starcie', 'Półka ~6 kHz, zakres −12…+12 dB.'],
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
        page.add(sound);

        this._addPresetGroup(page, settings, {
            title: 'Presety obrazu',
            description: 'Osobne od dźwięku. W panelu: klik = wczytaj, + = zapisz, prawy przycisk = nadpisz / zmień nazwę / usuń.',
            listKey: 'picture-presets',
            activeKey: 'picture-preset-active',
            kind: 'picture',
            namePrefix: 'Obraz',
            factory: PICTURE_FACTORY,
            format: formatPicture,
            snapshot: () => ({
                percent: settings.get_int('percent'),
                contrast: settings.get_int('contrast'),
                temperature: settings.get_int('temperature'),
                saturation: settings.get_int('saturation'),
            }),
        });

        this._addPresetGroup(page, settings, {
            title: 'Presety dźwięku',
            description: 'Osobne od obrazu. Bas / średnie / sopran.',
            listKey: 'sound-presets',
            activeKey: 'sound-preset-active',
            kind: 'sound',
            namePrefix: 'Dźwięk',
            factory: SOUND_FACTORY,
            format: formatSound,
            snapshot: () => ({
                bass: settings.get_int('eq-bass'),
                mid: settings.get_int('eq-mid'),
                treble: settings.get_int('eq-treble'),
            }),
        });

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({
            title: 'Przywróć wszystkie suwaki',
            subtitle: 'Jasność 100%, kontrast 0, temperatura 0, nasycenie 0, equalizer 0 dB. Presety zostają.',
        });
        const resetBtn = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
        });
        resetBtn.add_css_class('destructive-action');
        resetBtn.connect('clicked', () => {
            settings.set_int('percent', 100);
            settings.set_int('contrast', 0);
            settings.set_int('temperature', 0);
            settings.set_int('saturation', 0);
            settings.set_int('eq-bass', 0);
            settings.set_int('eq-mid', 0);
            settings.set_int('eq-treble', 0);
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
                const row = new Adw.EntryRow({
                    title: preset.name,
                    text: preset.name,
                    show_apply_button: true,
                });
                row.set_tooltip_text(spec.format(preset));
                if (preset.id === active)
                    row.add_css_class('success');

                row.connect('apply', () => {
                    const name = sanitizeName(row.text, preset.name);
                    const next = list.map(item => item.id === preset.id
                        ? {...item, name}
                        : item);
                    settings.set_string(spec.listKey, serializePresets(next));
                });

                const loadBtn = new Gtk.Button({
                    icon_name: 'document-open-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Wczytaj',
                });
                loadBtn.add_css_class('flat');
                loadBtn.connect('clicked', () => {
                    if (spec.kind === 'sound') {
                        settings.set_int('eq-bass', preset.bass);
                        settings.set_int('eq-mid', preset.mid);
                        settings.set_int('eq-treble', preset.treble);
                    } else {
                        settings.set_int('percent', preset.percent);
                        settings.set_int('contrast', preset.contrast);
                        settings.set_int('temperature', preset.temperature);
                        settings.set_int('saturation', preset.saturation ?? 0);
                    }
                    settings.set_string(spec.activeKey, preset.id);
                });
                row.add_suffix(loadBtn);

                const saveBtn = new Gtk.Button({
                    icon_name: 'document-save-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Nadpisz bieżącymi suwakami',
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
                    tooltip_text: 'Usuń',
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
                title: 'Zapisz bieżące suwaki jako nowy preset',
                subtitle: list.length >= MAX_PRESETS
                    ? `Limit ${MAX_PRESETS} presetów.`
                    : `Zostanie jako „${nextDefaultName(list, spec.namePrefix)}”.`,
            });
            const addBtn = new Gtk.Button({
                label: 'Dodaj',
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
                title: 'Przywróć presety fabryczne',
                subtitle: 'Dodaje brakujące (Noc, Dzień, Bas, Głos…). Twoich nie kasuje.',
            });
            const factoryBtn = new Gtk.Button({
                label: 'Przywróć',
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
