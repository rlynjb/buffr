/** @jsxImportSource @opentui/react */
import { useState, useEffect, useRef } from 'react';
import { createCliRenderer, TextAttributes } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taRef = useRef<any>(null);

  const handleSubmit = (): void => {
    const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
    if (busy || !q) return;
    taRef.current?.setText('');
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

  useKeyboard((e: any) => {
    if (e.name !== 'return' && e.name !== 'kpenter') return;
    if (e.ctrl || e.super || e.hyper) return;
    if (busy) return;
    e.preventDefault();
    if (e.meta) {
      taRef.current?.newLine();
    } else {
      handleSubmit();
    }
  });

  return (
    <box flexDirection="column" height="100%" paddingLeft={2} paddingRight={2}>

      {/* header — fixed height */}
      <box flexShrink={0} paddingTop={1} marginBottom={1}>
        <text fg="#888888">buffr chat — one conversation, held in-process. Type /exit to quit.</text>
      </box>

      {/* turns — scrollable, grows to fill remaining space */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <scrollbox flexGrow={1} scrollY stickyScroll stickyStart="bottom" scrollbarOptions={{ color: '#333333' } as any}>
        {turns.map((t, i) => (
          <box key={i} flexDirection="column" marginBottom={1}>
            {t.role === 'you' ? (
              <>
                <text attributes={TextAttributes.BOLD} fg="#00CCFF">› you</text>
                <text fg="#66BBCC" marginLeft={2}>{t.text}</text>
              </>
            ) : (
              <>
                <text attributes={TextAttributes.BOLD} fg="#00EE66">◆ buffr</text>
                <text fg="#E8E8E8" marginLeft={2}>{t.text}</text>
              </>
            )}
          </box>
        ))}
        {busy && <Spinner />}
      </scrollbox>

      {/* input — fixed at bottom */}
      {!busy && (
        <box
          flexShrink={0}
          border={true}
          borderStyle="rounded"
          borderColor="#444444"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
        >
          <textarea
            ref={taRef}
            placeholder="type your message… (Alt+Enter for new line)"
            textColor="#CCCCCC"
            placeholderColor="#555555"
            onSubmit={handleSubmit}
            focused
          />
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
