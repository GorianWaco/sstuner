# SSTuner

GNOME Shell extension for picture and sound controls in Quick Settings.

- Brightness (DDC/CI 10–100%, software boost above 100%)
- Contrast, color temperature, saturation
- 3-band equalizer (bass / mid / treble) via PipeWire
- Separate picture and sound presets
- Foldable **Picture** and **Sound** sections (collapsed by default)

Requires GNOME Shell 45–50.

## Optional dependencies

- `ddcutil` — hardware monitor backlight
- `pipewire` and `pw-cli` — equalizer

Arch: `sudo pacman -S ddcutil pipewire pipewire-audio`

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
