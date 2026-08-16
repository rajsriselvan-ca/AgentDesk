import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSummary,
  ConversationSummaryDTO,
  MessageDTO,
  TurnPhase,
  UserDTO,
} from '@agentdesk/core';

import { api, getCurrentUserId, setCurrentUserId } from './lib/api.js';
import { useChat, type LiveTurn } from './lib/useChat.js';

/**
 * The chat UI.
 *
 * Kept deliberately plain — the brief asks for a basic interface, so the effort
 * goes into state honesty rather than visual ambition. Three things get real
 * attention: the live indicator reflects the actual phase from the stream, the
 * trace shows what the router decided and which tools ran, and every failure
 * mode has a specific screen instead of a generic error.
 */

const AGENT_LABELS: Record<string, string> = {
  support: 'Support',
  order: 'Orders',
  billing: 'Billing',
  fallback: 'General',
};

const PHASE_ACTIVITY: Record<TurnPhase, { words: string[]; hint: string }> = {
  received: {
    words: ['Reading your message', 'Understanding the request', 'Gathering context'],
    hint: 'Preparing your request',
  },
  routing: {
    words: ['Choosing a specialist', 'Classifying the request', 'Finding the right desk'],
    hint: 'Matching your question to the best agent',
  },
  thinking: {
    words: ['Thinking', 'Reviewing context', 'Planning the answer'],
    hint: 'The specialist is working through the details',
  },
  calling_tool: {
    words: ['Searching records', 'Checking the database', 'Verifying details'],
    hint: 'Looking up the latest information',
  },
  writing: {
    words: ['Writing the reply', 'Summarizing the result', 'Preparing your answer'],
    hint: 'Turning the findings into a clear response',
  },
  compacting: {
    words: ['Organizing history', 'Condensing context', 'Reviewing earlier messages'],
    hint: 'Keeping the important conversation details in view',
  },
};

export default function App() {
  const [users, setUsers] = useState<UserDTO[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [conversations, setConversations] = useState<ConversationSummaryDTO[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);

  const refreshConversations = useCallback(async () => {
    if (!getCurrentUserId()) return;
    try {
      const response = await api.api.chat.conversations.$get({ query: { limit: '30' } });
      if (!response.ok) return;
      const body = await response.json();
      setConversations(body.items);
    } catch {
      // A failed refresh is not worth interrupting the conversation over; the
      // list simply stays as it was.
    }
  }, []);

  const chat = useChat({
    onConversationCreated: (conversationId) => {
      setActiveId(conversationId);
      void refreshConversations();
    },
    onTurnComplete: () => void refreshConversations(),
  });

  const { reset } = chat;

  // Boot: load the demo users and the agent roster.
  useEffect(() => {
    void (async () => {
      try {
        const [usersResponse, agentsResponse] = await Promise.all([
          api.api.users.$get(),
          api.api.agents.$get(),
        ]);

        if (!usersResponse.ok) throw new Error('Could not load the demo users.');

        const usersBody = await usersResponse.json();
        setUsers(usersBody.users);

        if (agentsResponse.ok) setAgents((await agentsResponse.json()).agents);

        const first = usersBody.users[0];
        if (first) {
          setCurrentUserId(first.id);
          setUserId(first.id);
        }
      } catch (error) {
        setBootError(
          error instanceof Error
            ? error.message
            : 'The API is not reachable. Is it running on port 3001?',
        );
      }
    })();
  }, []);

  useEffect(() => {
    if (userId) void refreshConversations();
  }, [userId, refreshConversations]);

  const openConversation = useCallback(
    async (conversationId: string) => {
      setActiveId(conversationId);
      setLoadingConversation(true);
      try {
        const response = await api.api.chat.conversations[':id'].$get({
          param: { id: conversationId },
        });
        if (!response.ok) throw new Error('That conversation could not be loaded.');
        const body = await response.json();
        reset(body.messages as MessageDTO[]);
      } catch {
        reset([]);
      } finally {
        setLoadingConversation(false);
      }
    },
    [reset],
  );

  const startNew = useCallback(() => {
    setActiveId(undefined);
    reset([]);
  }, [reset]);

  const switchUser = useCallback(
    (nextUserId: string) => {
      setCurrentUserId(nextUserId);
      setUserId(nextUserId);
      setActiveId(undefined);
      reset([]);
    },
    [reset],
  );

  const removeConversation = useCallback(
    async (conversationId: string) => {
      try {
        await api.api.chat.conversations[':id'].$delete({ param: { id: conversationId } });
      } finally {
        if (activeId === conversationId) startNew();
        void refreshConversations();
      }
    },
    [activeId, refreshConversations, startNew],
  );

  if (bootError) {
    return (
      <div className="boot-error">
        <h1>AgentDesk cannot reach the API</h1>
        <p>{bootError}</p>
        <ol>
          <li>
            Check the API is running: <code>pnpm --filter @agentdesk/api dev</code>
          </li>
          <li>
            Confirm it answers: <code>curl localhost:3001/health</code>
          </li>
          <li>
            If the database is down, start it and run <code>pnpm db:migrate &amp;&amp; pnpm db:seed</code>
          </li>
        </ol>
        <button onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar
        users={users}
        userId={userId}
        agents={agents}
        conversations={conversations}
        activeId={activeId}
        onSwitchUser={switchUser}
        onOpen={openConversation}
        onNew={startNew}
        onDelete={removeConversation}
      />

      <ChatPanel
        chat={chat}
        activeId={activeId}
        loading={loadingConversation}
        agents={agents}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface SidebarProps {
  users: UserDTO[];
  userId: string | null;
  agents: AgentSummary[];
  conversations: ConversationSummaryDTO[];
  activeId: string | undefined;
  onSwitchUser: (id: string) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

function Sidebar(props: SidebarProps) {
  const [pendingDelete, setPendingDelete] = useState<ConversationSummaryDTO | null>(null);

  useEffect(() => {
    if (!pendingDelete) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPendingDelete(null);
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [pendingDelete]);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    props.onDelete(pendingDelete.id);
    setPendingDelete(null);
  };

  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>AgentDesk</span>
        </div>

        <label className="field">
          <span className="field-label">Signed in as</span>
          <select
            value={props.userId ?? ''}
            onChange={(event) => props.onSwitchUser(event.target.value)}
          >
            {props.users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.tier}
              </option>
            ))}
          </select>
        </label>

        <button className="primary" onClick={props.onNew}>
          New conversation
        </button>

        <div className="section-label">Conversations</div>

        <ul className="conversations">
          {props.conversations.length === 0 && (
            <li className="empty">No conversations yet. Ask something to start one.</li>
          )}

          {props.conversations.map((conversation) => (
            <li
              key={conversation.id}
              className={conversation.id === props.activeId ? 'active' : undefined}
            >
              <button className="conversation" onClick={() => props.onOpen(conversation.id)}>
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-meta">
                  {conversation.lastAgent && (
                    <span className={`chip chip-${conversation.lastAgent}`}>
                      {AGENT_LABELS[conversation.lastAgent]}
                    </span>
                  )}
                  <span>{conversation.messageCount} messages</span>
                </span>
              </button>
              <button
                className="icon"
                aria-label={`Delete ${conversation.title}`}
                onClick={() => setPendingDelete(conversation)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="section-label">Agents</div>
        <ul className="agent-list">
          {props.agents.map((agent) => (
            <li key={agent.type}>
              <span className={`chip chip-${agent.type}`}>{agent.name}</span>
              <span className="agent-tools">{agent.toolCount} tools</span>
            </li>
          ))}
        </ul>
      </aside>

      {pendingDelete && (
        <div className="sidebar-confirm-layer" onMouseDown={() => setPendingDelete(null)}>
          <div
            className="sidebar-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-conversation-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p id="delete-conversation-title">Do you want to Delete this Chat ?</p>
            <div className="confirm-actions">
              <button className="ghost" onClick={() => setPendingDelete(null)} autoFocus>
                Cancel
              </button>
              <button className="danger" onClick={confirmDelete}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

interface ChatPanelProps {
  chat: ReturnType<typeof useChat>;
  activeId: string | undefined;
  loading: boolean;
  agents: AgentSummary[];
}

function ChatPanel({ chat, activeId, loading, agents }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.messages, chat.turn?.text]);

  const busy = chat.turn !== null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft('');
    chat.send(content, activeId);
  };

  const suggestions = useMemo(
    () => [
      'Where is my order AD-10604?',
      'Why has my refund for AD-10432 not arrived?',
      'How long do I have to return something?',
      'Can I cancel order AD-10711?',
    ],
    [],
  );

  return (
    <main className="chat">
      <div className="messages" ref={scrollRef} aria-live="polite">
        {loading && <div className="notice">Loading conversation…</div>}

        {!loading && chat.messages.length === 0 && !busy && (
          <div className="welcome">
            <h1>How can the desk help?</h1>
            <p>
              Ask about an order, a bill, or a product problem. A router reads the question and
              hands it to whichever specialist owns it — you will see which one, and why.
            </p>
            <div className="suggestions">
              {suggestions.map((suggestion) => (
                <button key={suggestion} onClick={() => chat.send(suggestion, activeId)}>
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="agent-hint">
              {agents.length} agents available:{' '}
              {agents.map((agent) => agent.name).join(', ')}
            </p>
          </div>
        )}

        {chat.messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}

        {chat.turn && <LiveMessage turn={chat.turn} />}

        {chat.error && (
          <div className="error-card">
            <strong>{chat.error.transport ? 'Connection lost' : 'That did not work'}</strong>
            <p>{chat.error.message}</p>
            {chat.error.retryable && (
              <button className="primary" onClick={chat.retry}>
                Retry
              </button>
            )}
          </div>
        )}

        <div className="message-end" aria-hidden="true" />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          placeholder="Ask about an order, a bill, or a problem…"
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) submit(event);
          }}
          disabled={busy}
        />
        {busy ? (
          <button type="button" className="ghost" onClick={chat.stop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={draft.trim().length === 0}>
            Send
          </button>
        )}
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------

function Message({ message }: { message: MessageDTO }) {
  const [showTrace, setShowTrace] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="message user">
        <div className="bubble">{message.content}</div>
      </div>
    );
  }

  return (
    <div className="message assistant">
      <div className="message-head">
        {message.agent && (
          <span className={`chip chip-${message.agent}`}>{AGENT_LABELS[message.agent]}</span>
        )}
        {message.trace && (
          <button className="link" onClick={() => setShowTrace((value) => !value)}>
            {showTrace ? 'Hide' : 'Show'} reasoning
          </button>
        )}
      </div>

      <div className="bubble">{message.content}</div>

      {showTrace && message.trace && (
        <div className="trace">
          <div className="trace-row">
            <span className="trace-key">Routed to</span>
            <span>
              {AGENT_LABELS[message.trace.agent]} · confidence{' '}
              {Math.round(message.trace.confidence * 100)}%
              {message.trace.fellBack && ' · overridden to fallback (low confidence)'}
            </span>
          </div>
          <div className="trace-row">
            <span className="trace-key">Why</span>
            <span>{message.trace.reasoning}</span>
          </div>
          {message.trace.toolCalls.length > 0 && (
            <div className="trace-row">
              <span className="trace-key">Tools</span>
              <span>
                {message.trace.toolCalls.map((call) => (
                  <span key={call.callId} className="tool-line">
                    <code>{call.tool}</code> → {call.summary}{' '}
                    <em>{call.durationMs}ms{call.ok ? '' : ' · failed'}</em>
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className="trace-row">
            <span className="trace-key">Cost</span>
            <span>
              {message.trace.promptTokens} in / {message.trace.completionTokens} out ·{' '}
              {message.trace.durationMs}ms
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function LiveMessage({ turn }: { turn: LiveTurn }) {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    setWordIndex(0);
    const timer = window.setInterval(() => setWordIndex((index) => index + 1), 1000);
    return () => clearInterval(timer);
  }, [turn.phase]);

  const activity = PHASE_ACTIVITY[turn.phase];
  const words =
    turn.phase === 'calling_tool' && turn.detail
      ? [`Searching ${turn.detail}`, 'Checking the database', 'Verifying the result']
      : activity.words;
  const label = words[wordIndex % words.length];

  return (
    <div className="message assistant live-message">
      <div className="message-head">
        {turn.agent ? (
          <span className={`chip chip-${turn.agent}`}>{AGENT_LABELS[turn.agent]}</span>
        ) : (
          <span className="chip chip-pending">Routing</span>
        )}
      </div>

      <div className="activity" role="status" aria-label={`${label}. ${activity.hint}`}>
        <span className="activity-orbit" aria-hidden="true">
          <i />
          <i />
        </span>
        <span className="activity-copy">
          <strong>{label}</strong>
          <span>{activity.hint}</span>
        </span>
        <span className="activity-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="activity-progress" aria-hidden="true" />
      </div>

      {turn.reasoning && <div className="live-reasoning">{turn.reasoning}</div>}

      {turn.toolCalls.length > 0 && (
        <div className="live-tools">
          {turn.toolCalls.map((call) => (
            <span key={call.callId} className="tool-pill">
              <code>{call.tool}</code> {call.summary}
            </span>
          ))}
        </div>
      )}

      {turn.text && <div className="bubble">{turn.text}</div>}
    </div>
  );
}
