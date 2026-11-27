import { useId, useState, type FormEvent } from "react";
import { Icon } from "./Icon";

interface Props {
  openRouterKey: string;
  /** Saves the key in this browser ("" removes it). False when the browser refuses to store it. */
  onSaveKey: (key: string) => boolean;
  onClose: () => void;
}

/** The OpenRouter key, kept in this browser. Claude Code and Codex need none. */
export function SettingsPanel({ openRouterKey, onSaveKey, onClose }: Props) {
  const uid = useId();
  const [draft, setDraft] = useState(openRouterKey);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (key: string) => {
    if (onSaveKey(key)) onClose();
    else setError("This browser blocked storage, so the key could not be saved. Allow site data, or leave private browsing.");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const key = draft.trim();
    // Anything outside printable ASCII cannot be sent in an HTTP header.
    if (key && !/^[\x21-\x7e]{1,300}$/.test(key)) setError("An API key has no spaces, line breaks or special characters. Paste only the key itself.");
    else save(key);
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`${uid}-key`}>OpenRouter API key</label>
        <div className="key-row">
          <input
            id={`${uid}-key`}
            type={reveal ? "text" : "password"}
            value={draft}
            placeholder="sk-or-v1-…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={`${uid}-note`}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
          <button type="button" className="btn btn--secondary" onClick={() => setReveal((v) => !v)} aria-label={reveal ? "Hide key" : "Show key"} aria-pressed={reveal}>
            <Icon name={reveal ? "eyeOff" : "eye"} />
          </button>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <p id={`${uid}-note`} className="field-hint">
          Stored only in this browser and sent only to this app&apos;s local server, which forwards it to OpenRouter. Get one at{" "}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
            openrouter.ai/keys
          </a>
          .
        </p>
      </div>

      <div className="settings-note">
        <h3>Claude Code and Codex use your subscriptions</h3>
        <p>
          No key needed. The server runs the <code>claude</code> and <code>codex</code> apps you are already signed in to. If a robot shows &ldquo;Needs setup&rdquo;, run{" "}
          <code>claude auth login</code> or <code>codex login</code> in a terminal, then press <b>Check sign-in</b>.
        </p>
      </div>

      <div className="settings-form-actions">
        {openRouterKey && (
          <button type="button" className="btn btn--ghost btn--danger" onClick={() => save("")}>
            Remove key
          </button>
        )}
        <button type="submit" className="btn btn--primary">
          Save
        </button>
      </div>
    </form>
  );
}
