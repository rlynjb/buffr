/** @jsxImportSource @opentui/react */
import { useState, useEffect, useRef } from 'react';
import { createCliRenderer, TextAttributes } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { createChatSession, type ChatSession } from '../session.js';

type Turn = { role: 'you' | 'buffr'; text: string };

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KB = { name: string; action: string; ctrl?: boolean; shift?: boolean; meta?: boolean; super?: boolean };

// Full textarea key bindings: defaults verbatim, except return/kpenter now submit
// and shift+return inserts a newline. The keyBindings setter replaces, not merges.
const KEY_BINDINGS: KB[] = [
  { name: 'left',     action: 'move-left' },
  { name: 'right',    action: 'move-right' },
  { name: 'up',       action: 'move-up' },
  { name: 'down',     action: 'move-down' },
  { name: 'left',     shift: true, action: 'select-left' },
  { name: 'right',    shift: true, action: 'select-right' },
  { name: 'up',       shift: true, action: 'select-up' },
  { name: 'down',     shift: true, action: 'select-down' },
  { name: 'home',     action: 'buffer-home' },
  { name: 'end',      action: 'buffer-end' },
  { name: 'home',     shift: true, action: 'select-buffer-home' },
  { name: 'end',      shift: true, action: 'select-buffer-end' },
  { name: 'a',        ctrl: true, action: 'line-home' },
  { name: 'e',        ctrl: true, action: 'line-end' },
  { name: 'a',        ctrl: true, shift: true, action: 'select-line-home' },
  { name: 'e',        ctrl: true, shift: true, action: 'select-line-end' },
  { name: 'a',        meta: true, action: 'visual-line-home' },
  { name: 'e',        meta: true, action: 'visual-line-end' },
  { name: 'a',        meta: true, shift: true, action: 'select-visual-line-home' },
  { name: 'e',        meta: true, shift: true, action: 'select-visual-line-end' },
  { name: 'f',        ctrl: true, action: 'move-right' },
  { name: 'b',        ctrl: true, action: 'move-left' },
  { name: 'w',        ctrl: true, action: 'delete-word-backward' },
  { name: 'backspace', ctrl: true, action: 'delete-word-backward' },
  { name: 'd',        meta: true, action: 'delete-word-forward' },
  { name: 'delete',   meta: true, action: 'delete-word-forward' },
  { name: 'delete',   ctrl: true, action: 'delete-word-forward' },
  { name: 'd',        ctrl: true, shift: true, action: 'delete-line' },
  { name: 'k',        ctrl: true, action: 'delete-to-line-end' },
  { name: 'u',        ctrl: true, action: 'delete-to-line-start' },
  { name: 'backspace', action: 'backspace' },
  { name: 'backspace', shift: true, action: 'backspace' },
  { name: 'd',        ctrl: true, action: 'delete' },
  { name: 'delete',   action: 'delete' },
  { name: 'delete',   shift: true, action: 'delete' },
  // --- overrides: Enter=submit, Shift+Enter=newline ---
  { name: 'return',   action: 'submit' },
  { name: 'return',   shift: true, action: 'newline' },
  { name: 'kpenter',  action: 'submit' },
  { name: 'linefeed', action: 'newline' },
  { name: 'return',   meta: true, action: 'submit' },
  { name: 'kpenter',  meta: true, action: 'submit' },
  // ---------------------------------------------------
  { name: '-',        ctrl: true, action: 'undo' },
  { name: '.',        ctrl: true, action: 'redo' },
  { name: 'z',        super: true, action: 'undo' },
  { name: 'z',        super: true, shift: true, action: 'redo' },
  { name: 'f',        meta: true, action: 'word-forward' },
  { name: 'b',        meta: true, action: 'word-backward' },
  { name: 'right',    meta: true, action: 'word-forward' },
  { name: 'left',     meta: true, action: 'word-backward' },
  { name: 'right',    ctrl: true, action: 'word-forward' },
  { name: 'left',     ctrl: true, action: 'word-backward' },
  { name: 'f',        meta: true, shift: true, action: 'select-word-forward' },
  { name: 'b',        meta: true, shift: true, action: 'select-word-backward' },
  { name: 'right',    meta: true, shift: true, action: 'select-word-forward' },
  { name: 'left',     meta: true, shift: true, action: 'select-word-backward' },
  { name: 'backspace', meta: true, action: 'delete-word-backward' },
  { name: 'left',     super: true, action: 'visual-line-home' },
  { name: 'right',    super: true, action: 'visual-line-end' },
  { name: 'up',       super: true, action: 'buffer-home' },
  { name: 'down',     super: true, action: 'buffer-end' },
  { name: 'left',     super: true, shift: true, action: 'select-visual-line-home' },
  { name: 'right',    super: true, shift: true, action: 'select-visual-line-end' },
  { name: 'up',       super: true, shift: true, action: 'select-buffer-home' },
  { name: 'down',     super: true, shift: true, action: 'select-buffer-end' },
  { name: 'a',        super: true, action: 'select-all' },
];

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

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
      <box marginBottom={1}>
        <text fg="#888888">buffr chat — one conversation, held in-process. Type /exit to quit.</text>
      </box>
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
      {busy ? (
        <Spinner />
      ) : (
        <box
          border={true}
          borderStyle="rounded"
          borderColor="#444444"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
        >
          <textarea
            ref={taRef}
            placeholder="type your message… (Shift+Enter for new line)"
            textColor="#CCCCCC"
            placeholderColor="#555555"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          keyBindings={KEY_BINDINGS as any}
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
