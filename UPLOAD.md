# Publish SSTuner on extensions.gnome.org

Local packaging is already done. What only you can finish:

## 1. GitHub repository (required by review)

`metadata.json` points to https://github.com/gorian/sstuner

```bash
cd ~/Projekty/sstuner
gh auth login
gh repo create sstuner --public --source=. --remote=origin --push
```

If you prefer the website: create an empty public repo named `sstuner` under `gorian`, then:

```bash
cd ~/Projekty/sstuner
git remote add origin https://github.com/gorian/sstuner.git
git push -u origin main
```

The URL must open a real repository with an issue tracker. A 404 gets rejected.

## 2. Account on the GNOME store

Register: https://extensions.gnome.org/accounts/register/

## 3. Upload the ZIP

The packed file is on the Desktop:

`~/Pulpit/sstuner@gorian.github.io.shell-extension.zip`

Either:

- Browser: https://extensions.gnome.org/upload/ — attach the ZIP, add 2–3 screenshots from `screenshots/`
- Terminal (after you have the account):

```bash
gnome-extensions upload --accept-tos ~/Pulpit/sstuner@gorian.github.io.shell-extension.zip
```

## 4. After approval

Users install it like any other extension from the website. Updates are a new ZIP upload of the same UUID.
