/**
 * Weave Capture's phone page. Views only: the logic it calls lives in
 * `api.ts`, `uploader.ts` and `format.ts` (tested in Node) and the platform
 * glue in `browser.tsx`.
 */

import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MeetingSummary, PasskeyInfo, SessionState, TranscriptPayload } from "../shared/wire";
import { CaptureApi, type FetchLike } from "./api";
import { copyText, createPasskey, openPieceStore, passkeyError, Recorder, usePasskey } from "./browser";
import { clock, meetingLine, statusLabel, transcriptMarkdown } from "./format";
import { backoff, Uploader, type PieceStore } from "./uploader";

const api = new CaptureApi(((url, init) => fetch(url, init as RequestInit)) as FetchLike);

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section class="card">
      <h2>Save your recovery codes</h2>
      <p class="muted">If you lose every device with your passkey, one of these signs you in once. Keep them in your password manager. They won’t be shown again.</p>
      <div class="codes">{codes.map((code) => <span key={code}>{code}</span>)}</div>
      <div class="row">
        <button onClick={async () => setCopied(await copyText(codes.join("\n")))}>{copied ? "Copied" : "Copy codes"}</button>
        <button class="primary" onClick={onDone}>I saved them</button>
      </div>
    </section>
  );
}

function Setup({ onCodes }: { onCodes: (codes: string[]) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    const options = await api.setupOptions(name);
    if (!options.ok) return (setError(options.error), setBusy(false));
    try {
      const verified = await api.setupVerify(await createPasskey(options.data));
      if (!verified.ok) setError(verified.error);
      else onCodes(verified.data.codes);
    } catch (e) {
      setError(passkeyError(e));
    }
    setBusy(false);
  };
  return (
    <section class="card">
      <h1>Set up Weave Capture</h1>
      <p class="muted">Create a passkey on this phone. You’ll sign in with Face ID; there is no password.</p>
      <label for="name" class="small muted">Your name</label>
      <input id="name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="name" />
      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy || name.trim() === ""} onClick={submit}>Create passkey</button>
    </section>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const signIn = async () => {
    setBusy(true);
    setError("");
    const options = await api.loginOptions();
    if (!options.ok) return (setError(options.error), setBusy(false));
    try {
      const result = await api.loginVerify(await usePasskey(options.data));
      if (result.ok) onSignedIn();
      else setError(result.error);
    } catch (e) {
      setError(passkeyError(e));
    }
    setBusy(false);
  };
  const recover = async () => {
    setBusy(true);
    const result = await api.recover(code ?? "");
    setBusy(false);
    if (result.ok) onSignedIn();
    else setError(result.error);
  };
  return (
    <section class="card">
      <h1>Weave Capture</h1>
      {code === null ? (
        <>
          <button class="primary" disabled={busy} onClick={signIn}>Sign in with passkey</button>
          <button class="link" onClick={() => setCode("")}>Use a recovery code</button>
        </>
      ) : (
        <>
          <label for="code" class="small muted">Recovery code</label>
          <input id="code" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} autocomplete="one-time-code" autocapitalize="characters" />
          <button class="primary" disabled={busy || code.trim() === ""} onClick={recover}>Sign in</button>
          <button class="link" onClick={() => setCode(null)}>Use a passkey instead</button>
        </>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

function AddPasskey({ onDone, cancel }: { onDone: () => void; cancel?: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError("");
    const options = await api.passkeyOptions();
    if (!options.ok) return (setError(options.error), setBusy(false));
    try {
      const result = await api.passkeyVerify(await createPasskey(options.data));
      if (result.ok) onDone();
      else setError(result.error);
    } catch (e) {
      setError(passkeyError(e));
    }
    setBusy(false);
  };
  return (
    <section class="card">
      <h2>Add a passkey on this device</h2>
      <p class="muted">{cancel ? "Use it to sign in here with Face ID or Touch ID." : "You signed in with a recovery code. Add a passkey before you continue."}</p>
      {error && <p class="error">{error}</p>}
      <div class="row">
        <button class="primary" disabled={busy} onClick={add}>Add passkey</button>
        {cancel && <button onClick={cancel}>Cancel</button>}
      </div>
    </section>
  );
}

function Settings({ onSignedOut }: { onSignedOut: () => void }) {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [left, setLeft] = useState(0);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const result = await api.passkeys();
    if (result.ok) {
      setPasskeys(result.data.passkeys);
      setLeft(result.data.recoveryCodesLeft);
    } else setError(result.error);
  }, []);
  useEffect(() => void load(), [load]);
  if (codes) return <Codes codes={codes} onDone={() => setCodes(null)} />;
  if (adding) return <AddPasskey onDone={() => (setAdding(false), void load())} cancel={() => setAdding(false)} />;
  return (
    <section class="card">
      <h2>Passkeys</h2>
      <div class="list">
        {passkeys.map((passkey) => (
          <div class="item" key={passkey.id}>
            <div>
              {passkey.name}
              <small>Added {passkey.created.slice(0, 10)}{passkey.lastUsed ? `, last used ${passkey.lastUsed.slice(0, 10)}` : ""}</small>
            </div>
            <button
              class="danger"
              disabled={passkeys.length === 1}
              onClick={async () => {
                const result = await api.removePasskey(passkey.id);
                if (!result.ok) setError(result.error);
                void load();
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button onClick={() => setAdding(true)}>Add a passkey on this device</button>
      <h2>Recovery codes</h2>
      <p class="muted">{left} unused.</p>
      <button
        onClick={async () => {
          const result = await api.newRecoveryCodes();
          if (result.ok) setCodes(result.data.codes);
          else setError(result.error);
        }}
      >
        Make new recovery codes
      </button>
      {error && <p class="error">{error}</p>}
      <button class="danger" onClick={async () => (await api.logout(), onSignedOut())}>Sign out</button>
    </section>
  );
}

function TranscriptView({ slug, onRenamed, onChanged }: { slug: string; onRenamed: (slug: string) => void; onChanged: () => void }) {
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    const result = await api.transcript(slug);
    if (result.ok) setTranscript(result.data);
    else setError(result.error);
  }, [slug]);
  useEffect(() => {
    setTranscript(null);
    setCopied(false);
    void load();
  }, [load]);
  if (error) return <p class="error">{error}</p>;
  if (!transcript) return <p class="muted">Loading…</p>;
  const toggle = async () => {
    await api.setTranscriptStatus(slug, transcript.status === "new" ? "read" : "new");
    await load();
    onChanged();
  };
  return (
    <section class="card">
      {title === null ? (
        <div class="top">
          <h2>{transcript.title}</h2>
          <button class="link" onClick={() => setTitle(transcript.title)}>Rename</button>
        </div>
      ) : (
        <div class="row">
          <input id="title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
          <button
            class="primary"
            onClick={async () => {
              const result = await api.renameTranscript(slug, title);
              if (!result.ok) return setError(result.error);
              setTitle(null);
              onRenamed(result.data.slug);
            }}
          >
            Save
          </button>
        </div>
      )}
      <p class="muted small">{meetingLine(transcript)} · in your vault as {transcript.id}</p>
      <div class="row">
        <button class="primary" onClick={async () => setCopied(await copyText(transcriptMarkdown(transcript)))}>{copied ? "Copied" : "Copy as Markdown"}</button>
        <button onClick={toggle}>{transcript.status === "new" ? "Mark read" : "Mark new"}</button>
      </div>
      <pre class="transcript">{transcript.body}</pre>
    </section>
  );
}

function RecordingView({ meeting, onChanged }: { meeting: MeetingSummary; onChanged: () => void }) {
  const [error, setError] = useState("");
  return (
    <section class="card">
      <h2>{meeting.title}</h2>
      <p class="muted small">{meetingLine(meeting)}</p>
      {meeting.status === "failed" ? (
        <>
          <p class="error">Transcription failed: {meeting.error}</p>
          <div class="row">
            <button class="primary" onClick={async () => { const r = await api.retry(meeting.id); if (!r.ok) setError(r.error); onChanged(); }}>Try again</button>
            <button class="danger" onClick={async () => { const r = await api.discard(meeting.id); if (!r.ok) setError(r.error); onChanged(); }}>Delete recording</button>
          </div>
        </>
      ) : (
        <p>{meeting.status === "recording" ? "Audio is still uploading from a phone." : meeting.status === "queued" ? "Waiting for the Mac to transcribe it." : "Your Mac is transcribing it now."}</p>
      )}
      {error && <p class="error">{error}</p>}
    </section>
  );
}

function RecordPanel(props: { recorder: Recorder | null; recording: boolean; elapsed: number; waiting: number; syncError: string | null; durable: boolean; start: (title: string) => void; stop: () => void; error: string }) {
  const [title, setTitle] = useState("");
  return (
    <section class="card">
      {!props.recording && (
        <input id="meeting-title" placeholder="Meeting name (optional)" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      )}
      <div class="recorder">
        <button class={`recbtn${props.recording ? " on" : ""}`} aria-label={props.recording ? "Stop recording" : "Start recording"} disabled={!props.recorder} onClick={() => (props.recording ? props.stop() : (props.start(title), setTitle("")))}>
          <i />
        </button>
        <div class="time">{clock(props.elapsed)}</div>
        <div class={`state${props.recording ? " live" : ""}`}>{props.recording ? "Recording" : "Ready"}</div>
      </div>
      {props.recording && <p class="notice small">Keep this screen open. iPhone pauses recording if the screen locks or you switch apps.</p>}
      {props.waiting > 0 && <p class="muted small">{props.waiting} audio piece{props.waiting === 1 ? "" : "s"} waiting to upload{props.syncError ? `: ${props.syncError}` : "."}</p>}
      {!props.durable && <p class="notice small">This browser can’t store audio offline. Keep the page open until the upload finishes.</p>}
      {props.error && <p class="error">{props.error}</p>}
    </section>
  );
}

function Workspace({ onSignedOut }: { onSignedOut: () => void }) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [tab, setTab] = useState<string>("record");
  const [store, setStore] = useState<{ store: PieceStore; durable: boolean } | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [error, setError] = useState("");
  const attempts = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const result = await api.meetings();
    if (result.ok) setMeetings(result.data.meetings);
    else if (result.status === 401) onSignedOut();
  }, [onSignedOut]);

  const uploader = useMemo(() => (store ? new Uploader(store.store, api) : null), [store]);
  const sync = useCallback(async () => {
    if (!uploader) return;
    window.clearTimeout(timer.current);
    const report = await uploader.sync();
    setWaiting(report.waiting);
    setSyncError(report.error);
    if (report.finished.length > 0) void refresh();
    if (report.error) timer.current = window.setTimeout(() => void sync(), backoff(++attempts.current) * 1000);
    else attempts.current = 0;
  }, [uploader, refresh]);

  const recorder = useMemo(
    () => (store ? new Recorder(store.store, { onPiece: () => void sync(), onInterrupted: () => (setRecording(false), setError("Recording stopped: the browser paused the microphone. What was recorded is saved."), void sync()) }) : null),
    [store, sync],
  );

  useEffect(() => void openPieceStore().then(setStore), []);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => void sync(), [sync]);
  useEffect(() => {
    const online = () => void sync();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [sync]);
  useEffect(() => {
    if (!meetings.some((m) => m.kind === "recording")) return;
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [meetings, refresh]);
  useEffect(() => {
    if (!recording || !recorder) return;
    const id = window.setInterval(() => setElapsed(recorder.elapsed()), 500);
    return () => window.clearInterval(id);
  }, [recording, recorder]);

  const start = async (title: string) => {
    if (!recorder) return;
    setError("");
    const mime = Recorder.mime();
    const created = await api.createRecording({ ...(title.trim() ? { title } : {}), recorded: new Date().toISOString(), mime: mime || "audio/mp4" });
    if (!created.ok) return setError(created.error);
    try {
      await recorder.start(created.data.id, created.data.title, mime);
      setElapsed(0);
      setRecording(true);
      void refresh();
    } catch {
      await api.discard(created.data.id);
      setError("Weave Capture needs the microphone. Allow it in the browser’s settings and try again.");
    }
  };
  const stop = async () => {
    if (!recorder) return;
    await recorder.stop();
    setRecording(false);
    await sync();
    await refresh();
  };

  const current = meetings.find((m) => m.id === tab);
  return (
    <>
      <div class="top">
        <h1>Weave Capture</h1>
        <button class="link" onClick={() => setTab("settings")}>Settings</button>
      </div>
      <nav class="tabs" aria-label="Meetings">
        <button class={`tab${tab === "record" ? " on" : ""}${recording ? " rec" : ""}`} onClick={() => setTab("record")}>{recording ? `● ${clock(elapsed)}` : "Record"}</button>
        {meetings.map((m) => (
          <button key={m.id} class={`tab${tab === m.id ? " on" : ""}`} onClick={() => setTab(m.id)}>
            {m.title}
            {m.status === "new" && <span class="dot" aria-label="new" />}
          </button>
        ))}
      </nav>
      {tab === "settings" && <Settings onSignedOut={onSignedOut} />}
      {tab === "record" && (
        <>
          <RecordPanel recorder={recorder} recording={recording} elapsed={elapsed} waiting={waiting} syncError={syncError} durable={store?.durable ?? true} start={(t) => void start(t)} stop={() => void stop()} error={error} />
          <section class="card">
            <h2>Meetings</h2>
            {meetings.length === 0 ? (
              <p class="muted">Nothing yet. Tap the red button when the meeting starts.</p>
            ) : (
              <div class="list">
                {meetings.map((m) => (
                  <button class="item" key={m.id} onClick={() => setTab(m.id)}>
                    <div>
                      {m.title}
                      <small>{meetingLine(m)}</small>
                    </div>
                    <span class={`pill ${m.status}`}>{statusLabel(m.status)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
      {current?.kind === "transcript" && <TranscriptView slug={current.id} onRenamed={(slug) => (setTab(slug), void refresh())} onChanged={() => void refresh()} />}
      {current?.kind === "recording" && <RecordingView meeting={current} onChanged={() => void refresh()} />}
      {tab !== "record" && tab !== "settings" && !current && <p class="muted">That meeting is gone.</p>}
    </>
  );
}

function App() {
  const [state, setState] = useState<SessionState | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const result = await api.session();
    if (result.ok) setState(result.data);
    else setError(result.error);
  }, []);
  useEffect(() => void load(), [load]);
  if (codes) return <Codes codes={codes} onDone={() => (setCodes(null), void load())} />;
  if (!state) return <p class={error ? "error" : "boot"}>{error || "Loading…"}</p>;
  if (!state.setUp) return <Setup onCodes={setCodes} />;
  if (!state.signedIn) return <SignIn onSignedIn={() => void load()} />;
  if (state.recovery) return <AddPasskey onDone={() => void load()} />;
  return <Workspace onSignedOut={() => void load()} />;
}

render(<App />, document.getElementById("app")!);
