import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";

const HARNESS_MODELS: Record<string, string[]> = {
  Codex: ["GPT-6.2-Sol", "GPT-6.1-Terra"],
  "Claude Code": ["Sonnet", "Opus"],
  OpenClaw: ["Default"],
  Antigravity: ["Gemini 3.1 Pro", "Claude Sonnet 4.6"],
};

const STARTERS = [
  "Run Friday secretary review",
  "Inspect connected MCP tools",
  "Record an architecture decision to memory",
];

interface UserMessage {
  id: number;
  harness: string;
  model: string;
  text: string;
}

export function ChatView({
  totalTools,
  onOpenProxy,
}: {
  totalTools: number;
  onOpenProxy: () => void;
}) {
  const [harness, setHarness] = useState<string>("Claude Code");
  const [model, setModel] = useState<string>(HARNESS_MODELS["Claude Code"][0]);
  const [sessionTitle, setSessionTitle] = useState("Shared MCP proxy rollout");
  const [showSample, setShowSample] = useState(true);
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [input, setInput] = useState("");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && messages.length > 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function handleHarnessChange(nextHarness: string) {
    setHarness(nextHarness);
    setModel(HARNESS_MODELS[nextHarness][0]);
  }

  function handleNewChat() {
    setShowSample(false);
    setMessages([]);
    setSessionTitle("New chat");
    setShortcutsOpen(false);
    setInput("");
    textareaRef.current?.focus();
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (!showSample && messages.length === 0) {
      const firstLine = trimmed.split("\n")[0] ?? trimmed;
      setSessionTitle(firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine);
    }

    setMessages((prev) => [
      ...prev,
      { id: Date.now() + prev.length, harness, model, text: trimmed },
    ]);
    setInput("");
    setShortcutsOpen(false);
    textareaRef.current?.focus();
  }

  function applyStarter(prompt: string) {
    setInput(prompt);
    setShortcutsOpen(false);
    textareaRef.current?.focus();
  }

  const isEmpty = !showSample && messages.length === 0;

  return (
    <section id="chat" aria-labelledby="chat-heading">
      <header className="chat-header">
        <h1 id="chat-heading">Chat &amp; Handoffs</h1>
        <p>One conversation across your local harnesses.</p>
      </header>

      <div className="chat-workspace">
        <div className="chat-session">
          <div className="chat-session-top">
            <h2>{sessionTitle}</h2>
            <button type="button" className="button" onClick={handleNewChat}>
              <Icon name="plus" /> New Chat
            </button>
          </div>

          <div className="chat-controls">
            <label className="chat-selector">
              <span className="status-dot" aria-hidden="true" />
              <span className="chat-sr">Harness</span>
              <select
                aria-label="Harness"
                value={harness}
                onChange={(e) => handleHarnessChange(e.target.value)}
              >
                {Object.keys(HARNESS_MODELS).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label className="chat-selector">
              <span className="chat-sr">Model</span>
              <select
                aria-label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {HARNESS_MODELS[harness].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              id="chat-tools"
              className="button"
              onClick={onOpenProxy}
            >
              <Icon name="tools" />
              <span>{totalTools} proxied tools active</span>
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </div>

        <div className="chat-scroll" ref={scrollRef}>
          <div className="chat-transcript" aria-label="Conversation">
            {showSample && (
              <div>
                <article className="chat-turn">
                  <div className="chat-avatar" aria-hidden="true">
                    Y
                  </div>
                  <div>
                    <h3>You</h3>
                    <p>
                      Can you check the Linear rollout issues and summarize what still needs to
                      happen before we share the MCP proxy across harnesses?
                    </p>
                  </div>
                </article>

                <article className="chat-turn">
                  <div className="chat-avatar chat-agent" aria-hidden="true">
                    C
                  </div>
                  <div>
                    <h3>
                      Codex <span className="badge">GPT-6.2-Sol</span>
                    </h3>
                    <p>
                      Linear shows two open rollout items: complete the Notion OAuth connection and
                      confirm the shared endpoint works from Claude Code. Linear, GitHub, and
                      OpenDesign are already connected.
                    </p>
                    <details className="chat-tool-call">
                      <summary>
                        <code>linear__list_issues · 140ms</code>
                      </summary>
                      <p>Read-only lookup · Project: MCP proxy rollout · Filter: open issues</p>
                    </details>
                    <div className="chat-approval">
                      <Icon name="shield" />
                      <span>
                        Approval ready{" "}
                        <span className="chat-approval-detail">· Notion authorization pending</span>
                      </span>
                    </div>
                  </div>
                </article>

                <div className="chat-handoff">
                  <Icon name="flow" />
                  <span>Switched to Claude Code · resumed with 2 missed events</span>
                </div>

                <article className="chat-turn">
                  <div className="chat-avatar chat-agent" aria-hidden="true">
                    CC
                  </div>
                  <div>
                    <h3>
                      Claude Code <span className="badge">Sonnet</span>
                    </h3>
                    <p>
                      I’ve picked up both rollout items. I’ll start by checking{" "}
                      <code>127.0.0.1:3847/mcp</code> from this harness. Once Notion is authorized,
                      we can compare the tool list and record the result in the rollout notes.
                    </p>
                  </div>
                </article>
              </div>
            )}

            {isEmpty && (
              <div className="chat-empty">
                <div className="chat-avatar chat-agent" aria-hidden="true">
                  <Icon name="chat" />
                </div>
                <h3>Start a conversation</h3>
                <p>Choose a harness and model, or start with a prompt.</p>
                <div className="chat-starters">
                  {STARTERS.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="button"
                      onClick={() => applyStarter(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div role="log" aria-label="New messages">
              {messages.map((msg) => (
                <div key={msg.id}>
                  <article className="chat-turn">
                    <div className="chat-avatar" aria-hidden="true">
                      Y
                    </div>
                    <div>
                      <h3>
                        You{" "}
                        <span className="badge">
                          {msg.harness} · {msg.model}
                        </span>
                      </h3>
                      <p>{msg.text}</p>
                    </div>
                  </article>
                  <p className="chat-adapter">Chat adapter not wired yet — coming in Phase 2</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="chat-compose-area">
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
          >
            <label className="chat-sr" htmlFor="chat-input">
              Message
            </label>
            <textarea
              ref={textareaRef}
              id="chat-input"
              rows={1}
              placeholder="Ask any harness… Switch models or harnesses at any turn boundary"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSend();
                }
                if (
                  e.key === "/" &&
                  !input &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.altKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  setShortcutsOpen(true);
                }
              }}
            />
            <div className="chat-compose-actions">
              <details
                className="chat-shortcuts"
                open={shortcutsOpen}
                onToggle={(e) => setShortcutsOpen(e.currentTarget.open)}
              >
                <summary className="button">
                  <code>/</code> Workflows
                </summary>
                <div className="chat-shortcut-list">
                  <button
                    type="button"
                    className="button"
                    onClick={() => applyStarter("Run Friday secretary review")}
                  >
                    Run Friday secretary review
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => applyStarter("Record an architecture decision to memory")}
                  >
                    Record an architecture decision to memory
                  </button>
                </div>
              </details>

              <span className="chat-current">
                <span className="status-dot" aria-hidden="true" />
                <span>
                  {harness} · {model}
                </span>
              </span>

              <button
                id="chat-send"
                type="submit"
                className="button primary"
                disabled={!input.trim()}
              >
                Send <span aria-hidden="true">↑</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
