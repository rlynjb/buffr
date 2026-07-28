/** @jsxImportSource @opentui/react */
import { useState, useEffect } from 'react';
import { createCliRenderer, TextAttributes } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createChatSession, type ChatSession } from '../session.js';

type Turn = { role: 'you' | 'buffr'; text: string };

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <text fg="#FFFF00">{FRAMES[frame]} thinking…</text>;
}

function Chat({ session, onExit }: { session: ChatSession; onExit: () => Promise<void> }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const onSubmit = (value: string): void => {
    const q = value.trim();
    if (busy || !q) return;
    if (q === '/exit' || q === '/quit') {
      onExit().catch(err => { console.error(err); process.exit(1); });
      return;
    }
    setTurns(t => [...t, { role: 'you', text: q }]);
    setBusy(true);
    session.ask(q).then(
      answer => {
        setTurns(t => [...t, { role: 'buffr', text: answer }]);
        setBusy(false);
      },
      err => {
        setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
        setBusy(false);
      },
    );
  };

  return (
    <box flexDirection="column">
      <box marginBottom={1}>
        <text fg="#888888">buffr chat — one conversation, held in-process. Type /exit to quit.</text>
      </box>
      {turns.map((t, i) => (
        <box key={i} flexDirection="column" marginBottom={1}>
          {t.role === 'you' ? (
            <>
              <text attributes={TextAttributes.BOLD} fg="#00CCFF">› you</text>
              <text fg="#66BBCC">{t.text}</text>
            </>
          ) : (
            <>
              <text attributes={TextAttributes.BOLD} fg="#00EE66">◆ buffr</text>
              <text fg="#E8E8E8">{t.text}</text>
            </>
          )}
        </box>
      ))}
      {busy ? (
        <Spinner />
      ) : (
        <box>
          <text fg="#00FFFF">{'> '}</text>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <input placeholder="ask buffr" onSubmit={onSubmit as any} focused />
        </box>
      )}
    </box>
  );
}

const session = await createChatSession();
const renderer = await createCliRenderer({ exitOnCtrlC: false });

createRoot(renderer).render(
  <Chat
    session={session}
    onExit={async () => {
      await session.close();
      process.exit(0);
    }}
  />,
);
