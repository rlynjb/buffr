import { useState } from 'react';
import { render, Box, Text, useApp } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { createChatSession, type ChatSession } from '../session.js';

type Turn = { role: 'you' | 'buffr'; text: string };

function Chat({ session }: { session: ChatSession }) {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (value: string): Promise<void> => {
    const q = value.trim();
    if (busy) return;
    if (q === '/exit' || q === '/quit') {
      await session.close();
      exit();
      return;
    }
    if (!q) return;
    setInput('');
    setTurns((t) => [...t, { role: 'you', text: q }]);
    setBusy(true);
    try {
      const answer = await session.ask(q);
      setTurns((t) => [...t, { role: 'buffr', text: answer }]);
    } catch (err) {
      setTurns((t) => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text dimColor>buffr chat — one conversation, held in-process. Type /exit to quit.</Text>
      </Box>
      {turns.map((t, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text bold color={t.role === 'you' ? 'cyan' : 'green'}>{t.role}</Text>
          <Text>{t.text}</Text>
        </Box>
      ))}
      {busy ? (
        <Text color="yellow">
          <Spinner type="dots" /> thinking…
        </Text>
      ) : (
        <Box>
          <Text color="cyan">{'> '}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="ask buffr" />
        </Box>
      )}
    </Box>
  );
}

const session = await createChatSession();
render(<Chat session={session} />);
