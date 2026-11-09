# Weave Capture

Record a meeting on your phone and get the transcript in your vault.

- The phone page records audio and uploads it in 10-second pieces. Each piece stays on the phone (IndexedDB) until the Mac confirms it, so a
  sleeping Mac or a dead zone delays the transcript but loses nothing.
- The server runs on the Mac that holds the vault, on `127.0.0.1` only. A Cloudflare Tunnel is the only way in.
- When you stop, the Mac joins the pieces, converts them with ffmpeg and transcribes them with whisper.cpp. Audio never leaves your
  machines. The transcript is a note in `meetings/` with `source: generated`, `kind: transcript` and `status: new`. Audio is kept for 7
  days, then removed.
- Your harness sees the note right away. The status line counts new meetings; `/weave-inbox` (Pi, OpenCode, Claude Code) or `weave_note`
  action `inbox` lists them and marks them read. The app can also copy a transcript as Markdown.

## Sign-in

Passkeys only, set up the same way as Hearthside: a discoverable key made on the device, Face ID or Touch ID required on every sign-in, no
attestation. The server stores only the public key. The first visit opens setup, which closes once your passkey exists, and shows ten
recovery codes; save them in your password manager. A recovery code signs you in once, and only lets you add a new passkey. Add your Mac's
Touch ID from Settings. Sessions last 30 days.

Sign-in data lives in `~/.okf-capture/auth.json` (mode 0600), outside the vault: session tokens and recovery codes are stored as SHA-256
hashes.

## Set up on the Mac

```sh
npm install -g pi-weave                      # or run src/capture/dist/capture.mjs from a checkout
brew install ffmpeg whisper-cpp cloudflared
pi-weave-capture doctor                      # checks everything and prints the model download command
```

Point the tunnel at the capture server (default port 3310):

```sh
cloudflared tunnel login
cloudflared tunnel create weave
cloudflared tunnel route dns weave weave.manta.run
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel id>
credentials-file: /Users/<you>/.cloudflared/<tunnel id>.json
ingress:
  - hostname: weave.manta.run
    service: http://localhost:3310
  - service: http_status:404
```

Then start both at login:

```sh
sudo cloudflared service install
pi-weave-capture install                     # a launch agent; log in ~/.okf-capture/capture.log
```

Open `https://weave.manta.run` on your phone, set up your passkey, save the recovery codes, and add the page to the home screen.

## Settings

Flags or environment variables, read by `serve` and baked into the launch agent by `install`:

| Flag | Variable | Default |
|---|---|---|
| `--origin` | `PI_WEAVE_CAPTURE_ORIGIN` | `https://weave.manta.run` (also the passkey's site; changing it means setting up passkeys again) |
| `--port` | `PI_WEAVE_CAPTURE_PORT` | `3310` |
| `--dir` | `PI_WEAVE_CAPTURE_DIR` | `~/.okf-capture` |
| `--whisper` | `PI_WEAVE_WHISPER` | `whisper-cli` |
| `--model` | `PI_WEAVE_WHISPER_MODEL` | `<dir>/models/ggml-large-v3-turbo.bin` |
| `--language` | `PI_WEAVE_WHISPER_LANG` | `auto` |
| `--ffmpeg` | `PI_WEAVE_FFMPEG` | `ffmpeg` |

The vault is `PI_WEAVE_VAULT` (default `~/.okf`), as everywhere else.

## Limits

- iPhone pauses browser recording when the screen locks or you switch apps. The page keeps the screen awake while recording and warns if the
  browser stops it; what was recorded is kept.
- Whisper gives timestamped text without speaker names.
- Transcription waits until the Mac is awake.
