# SSTuner

GNOME Shell extension for sound controls in Quick Settings.

- 3-band equalizer (bass / mid / treble) via PipeWire
- Spatial stereo (width / Haas) via PipeWire — works in games too
- Sound presets
- Foldable **Sound** section (collapsed by default)

Requires GNOME Shell 45–50.

## Optional dependencies

- `pipewire` and `pw-cli` — equalizer and spatial sound

Arch: `sudo pacman -S pipewire pipewire-audio`

## Install from ZIP

```bash
gnome-extensions install sstuner@gorianwaco.github.io.shell-extension.zip
```

Then log out and back in, and enable **SSTuner** in Extension Manager.

## Develop

```bash
glib-compile-schemas schemas
cp -a . ~/.local/share/gnome-shell/extensions/sstuner@gorianwaco.github.io
```

Do not symlink the project into the extensions directory before running
`gnome-extensions install --force` — the installer deletes the target.

Pack for [extensions.gnome.org](https://extensions.gnome.org):

```bash
./pack.sh
```

See `UPLOAD.md` for the remaining publish steps (account, GitHub repo, review).

## Translations

UI strings are English in the source and translated with gettext.
Available: Polish, Russian, German, Ukrainian (`po/`). `./pack.sh`
compiles them into the ZIP, so it needs `msgfmt` from the `gettext` package.

After changing UI strings, refresh the template and merge it into the
translations:

```bash
xgettext --language=JavaScript --from-code=UTF-8 --keyword=_ --keyword=N_ \
  --package-name=SSTuner \
  --msgid-bugs-address=https://github.com/GorianWaco/sstuner/issues \
  --sort-by-file -o po/sstuner.pot \
  extension.js prefs.js presets.js
for po in po/*.po; do msgmerge --update --backup=none "$po" po/sstuner.pot; done
```

To add a language, copy `po/sstuner.pot` to `po/<lang>.po` and translate it.
