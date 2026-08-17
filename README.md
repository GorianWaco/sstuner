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
