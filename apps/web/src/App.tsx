import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  CONNECTION_ERROR_MESSAGE,
  DEMO_PERSONAS,
  UNKNOWN_SERVER_ERROR_MESSAGE,
  applyActivityFrame,
  buildChatWebSocketUrl,
  buildOutgoingMessage,
  getActivityStateLabel,
  getSafeErrorMessage,
  parseServerFrame,
  type ActivityItem,
  type ConnectionState,
  type DemoCustomerRef,
  type TranscriptMessage,
} from "./chat";

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: "À démarrer",
  connecting: "Connexion…",
  open: "Connecté",
  closed: "Déconnecté",
};

function App() {
  const [selectedCustomerRef, setSelectedCustomerRef] = useState<DemoCustomerRef | "">("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const nextMessageIdRef = useRef(1);
  const currentTurnIdRef = useRef(0);
  const nextActivityIdRef = useRef(1);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const activityStreamRef = useRef<HTMLDivElement | null>(null);

  const selectedPersona = DEMO_PERSONAS.find((persona) => persona.customerRef === selectedCustomerRef) ?? null;

  function retireActiveSocket(): void {
    socketGenerationRef.current += 1;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      socket.close(1000, "Nouvelle conversation");
    }
  }

  function clearConversation(): void {
    setMessages([]);
    setDraft("");
    setError(null);
    setPending(false);
    setActivity([]);
    nextMessageIdRef.current = 1;
    currentTurnIdRef.current = 0;
    nextActivityIdRef.current = 1;
  }

  function startConversation(): void {
    if (selectedCustomerRef === "") return;

    retireActiveSocket();
    clearConversation();
    setConnectionState("connecting");

    let socket: WebSocket;
    try {
      const url = buildChatWebSocketUrl(selectedCustomerRef, import.meta.env.VITE_WS_URL, window.location);
      socket = new WebSocket(url);
    } catch {
      setConnectionState("closed");
      setError(CONNECTION_ERROR_MESSAGE);
      return;
    }

    const generation = socketGenerationRef.current + 1;
    socketGenerationRef.current = generation;
    socketRef.current = socket;

    const isCurrentSocket = (): boolean =>
      socketRef.current === socket && socketGenerationRef.current === generation;

    socket.onopen = () => {
      if (!isCurrentSocket()) return;
      setConnectionState("open");
      setError(null);
    };

    socket.onmessage = (event) => {
      if (!isCurrentSocket()) return;
      if (typeof event.data !== "string") {
        setPending(false);
        setError(UNKNOWN_SERVER_ERROR_MESSAGE);
        return;
      }

      const frame = parseServerFrame(event.data);
      if (frame === null) {
        setPending(false);
        setError(UNKNOWN_SERVER_ERROR_MESSAGE);
        return;
      }

      if (frame.type === "agent.message") {
        setMessages((current) => [
          ...current,
          { id: nextMessageIdRef.current++, role: "assistant", content: frame.content },
        ]);
        setPending(false);
        setError(null);
        return;
      }

      if (frame.type === "agent.error") {
        setError(getSafeErrorMessage(frame.code));
        if (frame.code !== "busy") setPending(false);
        return;
      }

      const turnId = currentTurnIdRef.current;
      if (turnId === 0) return;
      const activityId = nextActivityIdRef.current++;
      setActivity((current) => applyActivityFrame(current, frame, turnId, activityId));
    };

    socket.onerror = () => {
      if (!isCurrentSocket()) return;
      setConnectionState("closed");
      setPending(false);
      setError(CONNECTION_ERROR_MESSAGE);
    };

    socket.onclose = () => {
      if (!isCurrentSocket()) return;
      socketRef.current = null;
      setConnectionState("closed");
      setPending(false);
      setError((current) => current ?? CONNECTION_ERROR_MESSAGE);
    };
  }

  function handlePersonaChange(value: string): void {
    const persona = DEMO_PERSONAS.find((candidate) => candidate.customerRef === value);
    retireActiveSocket();
    clearConversation();
    setSelectedCustomerRef(persona?.customerRef ?? "");
    setConnectionState("idle");
  }

  function sendDraft(): void {
    const socket = socketRef.current;
    const outgoing = buildOutgoingMessage(draft);
    if (socket === null || socket.readyState !== WebSocket.OPEN || pending || outgoing === null) return;

    setMessages((current) => [
      ...current,
      { id: nextMessageIdRef.current++, role: "customer", content: outgoing.content },
    ]);
    setDraft("");
    setError(null);
    setPending(true);

    try {
      socket.send(JSON.stringify(outgoing));
      currentTurnIdRef.current += 1;
    } catch {
      retireActiveSocket();
      setConnectionState("closed");
      setPending(false);
      setError(CONNECTION_ERROR_MESSAGE);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    sendDraft();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendDraft();
    }
  }

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pending]);

  useEffect(() => {
    const stream = activityStreamRef.current;
    if (stream !== null) stream.scrollTop = stream.scrollHeight;
  }, [activity]);

  useEffect(() => {
    return () => {
      socketGenerationRef.current += 1;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
        socket.close(1000, "Fermeture du simulateur");
      }
    };
  }, []);

  const canSend = connectionState === "open" && !pending && draft.trim().length > 0;
  const activityGroups = activity.reduce<Array<{ turnId: number; items: ActivityItem[] }>>((groups, item) => {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup?.turnId === item.turnId) {
      lastGroup.items.push(item);
    } else {
      groups.push({ turnId: item.turnId, items: [item] });
    }
    return groups;
  }, []);

  return (
    <main className="app-shell">
      <div className="background-orb background-orb--one" aria-hidden="true" />
      <div className="background-orb background-orb--two" aria-hidden="true" />

      <section className="simulator" aria-label="Simulateur de chat M3AK">
        <aside className="setup-panel">
          <div>
            <a className="brand" href="#top" aria-label="M3AK, accueil">
              <span className="brand-mark" aria-hidden="true">M</span>
              <span>M3AK</span>
            </a>
            <p className="eyebrow">Simulateur commercial</p>
            <h1>Une conversation qui avance vers la vente.</h1>
            <p className="intro">
              Testez l’agent avec une persona Kenza réelle, en français, en Darija ou en arabe.
            </p>
          </div>

          <div className="persona-card">
            <label htmlFor="persona">Persona de démonstration</label>
            <div className="select-wrap">
              <select
                id="persona"
                value={selectedCustomerRef}
                onChange={(event) => handlePersonaChange(event.target.value)}
              >
                <option value="">Choisir une persona</option>
                {DEMO_PERSONAS.map((persona) => (
                  <option key={persona.customerRef} value={persona.customerRef}>
                    {persona.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="persona-hint">
              Chaque choix ouvre une conversation neuve avec un client déjà présent dans les données de démonstration.
            </p>

            {connectionState === "open" ? (
              <button className="button button--secondary" type="button" onClick={startConversation}>
                <span aria-hidden="true">↻</span>
                Nouvelle conversation
              </button>
            ) : (
              <button
                className="button button--primary"
                type="button"
                onClick={startConversation}
                disabled={selectedCustomerRef === "" || connectionState === "connecting"}
              >
                {connectionState === "connecting" ? "Connexion…" : "Démarrer la conversation"}
                <span aria-hidden="true">→</span>
              </button>
            )}
          </div>

          <div className="privacy-note">
            <span className="privacy-icon" aria-hidden="true">✓</span>
            <p>
              <strong>Données maîtrisées</strong>
              Le navigateur utilise uniquement le libellé et la référence de la persona sélectionnée.
            </p>
          </div>
        </aside>

        <section className="chat-panel" id="top">
          <header className="chat-header">
            <div className="agent-identity">
              <div className="agent-avatar" aria-hidden="true">M</div>
              <div>
                <h2>Assistant M3AK</h2>
                <p>{selectedPersona?.label ?? "Aucune persona sélectionnée"}</p>
              </div>
            </div>
            <div className={`connection-pill connection-pill--${connectionState}`} role="status" aria-live="polite">
              <span className="connection-dot" aria-hidden="true" />
              {CONNECTION_LABELS[connectionState]}
            </div>
          </header>

          <div className="transcript" aria-label="Conversation" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-illustration" aria-hidden="true">
                  <span>سلام</span>
                  <span>Bonjour</span>
                </div>
                <h3>
                  {connectionState === "open" ? "La conversation est prête" : "Commencez une nouvelle conversation"}
                </h3>
                <p>
                  {connectionState === "open"
                    ? "Écrivez un message naturel : recherchez un produit, vérifiez sa disponibilité ou préparez une commande."
                    : "Choisissez une persona, puis démarrez le simulateur pour échanger avec M3AK."}
                </p>
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message) => (
                  <article className={`message message--${message.role}`} key={message.id}>
                    <span className="message-author">
                      {message.role === "customer" ? selectedPersona?.label ?? "Client" : "M3AK"}
                    </span>
                    <p dir="auto">{message.content}</p>
                  </article>
                ))}
                {pending ? (
                  <div className="processing" role="status">
                    <span className="processing-dots" aria-hidden="true"><i /><i /><i /></span>
                    M3AK prépare sa réponse…
                  </div>
                ) : null}
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>

          <div className="composer-area">
            {error ? (
              <div className="error-banner" role="alert">
                <span aria-hidden="true">!</span>
                <p>{error}</p>
              </div>
            ) : null}

            <form className="composer" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="message">Votre message</label>
              <textarea
                id="message"
                rows={2}
                maxLength={4_000}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={connectionState === "open" ? "Écrivez votre message…" : "Démarrez une conversation pour écrire"}
                disabled={connectionState !== "open" || pending}
              />
              <button className="send-button" type="submit" disabled={!canSend} aria-label="Envoyer le message">
                <span>Envoyer</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m4 4 16 8-16 8 3-8-3-8Zm3.7 7h7.8L6.8 6.7 7.7 11Zm-.9 6.3 8.7-4.3H7.7l-.9 4.3Z" />
                </svg>
              </button>
            </form>
            <p className="composer-hint">Entrée pour envoyer · Maj + Entrée pour une nouvelle ligne</p>
          </div>
        </section>

        <aside className="activity-panel" aria-labelledby="activity-title">
          <header className="activity-header">
            <div>
              <p className="activity-eyebrow">Workflow</p>
              <h2 id="activity-title">Activité de l’agent</h2>
            </div>
            {connectionState === "open" ? (
              <div className="live-indicator" role="status">
                <span aria-hidden="true" />
                Temps réel
              </div>
            ) : null}
          </header>

          <div
            className="activity-stream"
            ref={activityStreamRef}
            aria-live="polite"
            aria-label="Événements réels de l’agent"
          >
            {activityGroups.length === 0 ? (
              <div className="activity-empty">
                <span className="activity-empty-mark" aria-hidden="true" />
                <p>Les actions réelles apparaîtront ici pendant la conversation.</p>
              </div>
            ) : (
              <div className="activity-turns">
                {activityGroups.map((group) => (
                  <section className="activity-turn" key={group.turnId} aria-label={`Tour ${group.turnId}`}>
                    <div className="turn-label"><span />Tour {group.turnId}</div>
                    <ol className="activity-list">
                      {group.items.map((item) => (
                        <li
                          className={`activity-item activity-item--${item.kind} activity-item--${item.state}`}
                          key={item.id}
                        >
                          <span className="activity-marker" aria-hidden="true" />
                          <div className="activity-copy">
                            <p>{item.label}</p>
                            {item.kind === "tool" ? (
                              <span className="activity-state">{getActivityStateLabel(item.state)}</span>
                            ) : null}
                            {item.details?.length ? (
                              <div className="activity-details">
                                {item.details.map((detail) => <span key={detail}>{detail}</span>)}
                              </div>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

export default App;
