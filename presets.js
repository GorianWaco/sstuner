// SPDX-License-Identifier: GPL-2.0-or-later
export const MAX_PRESETS = 10;
export const NAME_MAX = 20;

export const PICTURE_FACTORY = [
    {id: 'neutral', name: 'Neutralny', percent: 100, contrast: 0, saturation: 0},
    {id: 'night', name: 'Noc', percent: 55, contrast: -6, saturation: 0},
    {id: 'day', name: 'Dzień', percent: 120, contrast: 4, saturation: 0},
];

// Marks a string for xgettext; the caller translates it at display time.
const N_ = str => str;

export const SOUND_FACTORY = [
    {id: 'flat', name: N_('Flat'), bass: 0, mid: 0, treble: 0, spatial: 0},
    {id: 'bass', name: N_('Bass'), bass: 7, mid: -1, treble: -2, spatial: 0},
    {id: 'voice', name: N_('Voice'), bass: -3, mid: 5, treble: 3, spatial: 15},
    {id: 'bright', name: N_('Bright'), bass: -2, mid: 1, treble: 6, spatial: 25},
    {id: 'spatial', name: N_('Spatial'), bass: 1, mid: 0, treble: 2, spatial: 60},
];

// Factory names saved before translations existed.
const LEGACY_SOUND_NAMES = {
    flat: 'Płaski',
    bass: 'Bas',
    voice: 'Głos',
    bright: 'Jasny',
    spatial: 'Przestrzeń',
};

/**
 * Factory presets are shown translated until the user renames them.
 */
export function displayName(preset, translate) {
    const factory = SOUND_FACTORY.find(item => item.id === preset.id);
    if (factory && (preset.name === factory.name || preset.name === LEGACY_SOUND_NAMES[preset.id]))
        return translate(factory.name);
    return preset.name;
}

export function newPresetId(prefix) {
    return `${prefix}-${Date.now().toString(36)}`;
}

export function sanitizeName(name, fallback) {
    const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
    if (!trimmed)
        return fallback;
    return trimmed.slice(0, NAME_MAX);
}

export function nextDefaultName(list, prefix) {
    const used = new Set(list.map(p => p.name.toLowerCase()));
    let i = 1;
    while (used.has(`${prefix} ${i}`.toLowerCase()))
        i += 1;
    return `${prefix} ${i}`;
}

function asInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
}

export function normalizePicture(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = String(raw.id ?? '').trim();
    const name = sanitizeName(raw.name, '');
    if (!id || !name)
        return null;
    return {
        id,
        name,
        percent: asInt(raw.percent, 100),
        contrast: asInt(raw.contrast, 0),
        saturation: asInt(raw.saturation, 0),
    };
}

export function normalizeSound(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = String(raw.id ?? '').trim();
    const name = sanitizeName(raw.name, '');
    if (!id || !name)
        return null;
    return {
        id,
        name,
        bass: asInt(raw.bass, 0),
        mid: asInt(raw.mid, 0),
        treble: asInt(raw.treble, 0),
        spatial: asInt(raw.spatial, 0),
    };
}

export function parsePresets(raw, kind) {
    const normalize = kind === 'sound' ? normalizeSound : normalizePicture;
    let data = raw;
    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(data))
        return [];
    const seen = new Set();
    const out = [];
    for (const item of data) {
        const preset = normalize(item);
        if (!preset || seen.has(preset.id))
            continue;
        seen.add(preset.id);
        out.push(preset);
        if (out.length >= MAX_PRESETS)
            break;
    }
    return out;
}

export function serializePresets(list) {
    return JSON.stringify(list);
}

export function pictureEquals(a, b) {
    return a.percent === b.percent &&
        a.contrast === b.contrast &&
        a.saturation === b.saturation;
}

export function soundEquals(a, b) {
    return a.bass === b.bass &&
        a.mid === b.mid &&
        a.treble === b.treble &&
        a.spatial === b.spatial;
}

export function findMatching(list, snapshot, kind) {
    const equals = kind === 'sound' ? soundEquals : pictureEquals;
    return list.find(preset => equals(preset, snapshot)) ?? null;
}
