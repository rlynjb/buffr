/** @jsxImportSource @opentui/react */
import { useState, useEffect, useRef } from 'react';
import { createCliRenderer, TextAttributes } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { createChatSession, detectEntityType, type ChatSession, type TurnStats, type ProgressEvent } from '../session.js';

type Turn = { role: 'you' | 'buffr'; text: string; stats?: TurnStats; progressSteps?: ProgressStep[] };

type ProgressStep = {
  id: string;
  label: string;
  kind: 'engine' | 'connector' | 'stage';
  state: 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  model?: string;
};

function formatStats(s: TurnStats): string {
  const secs = s.durationMs / 1000;
  const time = secs >= 60
    ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
    : `${secs.toFixed(1)}s`;
  const tok = s.inputTokens + s.outputTokens > 0
    ? ` · ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out`
    : '';
  const pv = s.promptVersion ? ` · prompt ${s.promptVersion}` : '';
  return `${time}${tok}${pv}`;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function stepIcon(state: ProgressStep['state'], frame: number): string {
  return state === 'running' ? FRAMES[frame]
    : state === 'done'    ? '✓'
    : state === 'failed'  ? '✗'
    : '⊘';
}

function stepColor(state: ProgressStep['state']): string {
  return state === 'running' ? '#FFFF00'
    : state === 'done'    ? '#00EE66'
    : state === 'failed'  ? '#FF5555'
    : '#555555';
}

function StepList({ steps, frame = 0 }: { steps: ProgressStep[]; frame?: number }) {
  return (
    <>
      {steps.map((step, i) => {
        if (step.kind === 'engine') {
          return (
            <text key={i} fg="#888888" marginLeft={2}>◆ {step.label}</text>
          );
        }
        const modelTag = step.model
          ? ` · ${step.model.charAt(0).toUpperCase() + step.model.slice(1)}`
          : '';
        const detail = step.detail ? ` · ${step.detail}` : '';
        return (
          <text key={i} fg={stepColor(step.state)} marginLeft={4}>
            ⎿ {stepIcon(step.state, frame)} {step.label}{modelTag}{detail}
          </text>
        );
      })}
    </>
  );
}

function ProgressPanel({ status, tokens, steps }: {
  status: string;
  tokens: { input: number; output: number };
  steps: ProgressStep[];
}) {
  const [frame, setFrame] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const startRef = useRef<any>(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => {
      setFrame(f => (f + 1) % FRAMES.length);
      setElapsedMs(Date.now() - startRef.current);
    }, 100);
    return () => clearInterval(id);
  }, []);

  const secs = elapsedMs / 1000;
  const timeStr = secs >= 60
    ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`
    : `${secs.toFixed(1)}s`;
  const total = tokens.input + tokens.output;
  const tokStr = total > 0 ? ` · ${total.toLocaleString()} tok` : '';

  return (
    <box flexDirection="column">
      <text fg="#FFFF00">{FRAMES[frame]} {status} · {timeStr}{tokStr}</text>
      <StepList steps={steps} frame={frame} />
    </box>
  );
}

function Chat({ session, onExit }: { session: ChatSession; onExit: () => Promise<void> }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('thinking…');
  const [liveTokens, setLiveTokens] = useState({ input: 0, output: 0 });
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const progressStepsRef = useRef<ProgressStep[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useRef<any>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  }, [turns, busy, progressSteps, status]);

  const updateProgressSteps = (updater: (steps: ProgressStep[]) => ProgressStep[]): void => {
    setProgressSteps(prev => {
      const next = updater(prev);
      progressStepsRef.current = next;
      return next;
    });
  };

  const handleSubmit = (): void => {
    const q = (taRef.current?.plainText as string | undefined)?.trim() ?? '';
    if (busy || !q) return;
    taRef.current?.setText('');
    if (q === '/exit' || q === '/quit') {
      onExit().catch(err => { console.error(err); process.exit(1); });
      return;
    }
    if (q === '/help') {
      setTurns(t => [...t, { role: 'you', text: q }, { role: 'buffr', text: [
        'Available commands:',
        '',
        '/research <topic>',
        '  Market research — finds trending problems and product opportunities.',
        '  Example: /research digital planners for students',
        '',
        '/investing <ticker>',
        '  Analyze a stock or ETF across momentum, fundamentals, and sentiment.',
        '  Example: /investing AAPL',
        '  Example: /investing VTI',
        '',
        '/eval research',
        '  Run the market research scorer against built-in fixtures (3 cases).',
        '',
        '/eval investing',
        '  Run the investing scorer against built-in fixtures (company + ETF).',
        '',
        '<anything else>',
        '  Chat — ask buffr a general question using your knowledge base.',
        '  Example: What did I learn about Shopify last week?',
        '',
        '/exit  or  /quit',
        '  Close the session.',
        '',
      ].join('\n') }]);
      return;
    }
    if (q.startsWith('/investing ')) {
      const ticker = q.slice('/investing '.length).trim().toUpperCase();
      if (!ticker) return;
      const entityType = detectEntityType(ticker);
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true);
      setStatus('analyzing…');
      setLiveTokens({ input: 0, output: 0 });
      let capturedStats: TurnStats | undefined;
      session.analyze(ticker, entityType, {
        onStatus: (msg) => setStatus(msg),
        onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
        onComplete: (s) => { capturedStats = s; },
      }).then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer, stats: capturedStats }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}`, stats: capturedStats }]); setBusy(false); },
      );
      return;
    }
    if (q.startsWith('/research ')) {
      const topic = q.slice('/research '.length).trim();
      if (!topic) return;
      setTurns(t => [...t, { role: 'you', text: q }, { role: 'buffr', text: '' }]);
      progressStepsRef.current = [];
      setProgressSteps([]);
      setBusy(true); setStatus('researching…'); setLiveTokens({ input: 0, output: 0 });
      let capturedStats: TurnStats | undefined;
      session.research(topic, {
        onStatus: (msg) => setStatus(msg),
        onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
        onComplete: (s) => { capturedStats = s; },
        onPartial: (text) => setTurns(t => { const c = [...t]; c[c.length - 1] = { role: 'buffr', text }; return c; }),
        onProgress: (event: ProgressEvent) => {
          if (event.type === 'engine-start') {
            updateProgressSteps(s => [...s, { id: '__engine__', label: event.label, kind: 'engine', state: 'running' }]);
          } else if (event.type === 'connector-start') {
            updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'connector', state: 'running' }]);
          } else if (event.type === 'connector-done') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: 'done', detail: event.count > 0 ? `${event.count} result${event.count !== 1 ? 's' : ''}` : undefined }
              : step));
          } else if (event.type === 'connector-failed') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: event.optional ? 'skipped' : 'failed' }
              : step));
          } else if (event.type === 'stage-start') {
            updateProgressSteps(s => [...s, { id: event.id, label: event.label, kind: 'stage', state: 'running', model: event.model }]);
          } else if (event.type === 'stage-done') {
            updateProgressSteps(s => s.map(step => step.id === event.id
              ? { ...step, state: 'done', detail: event.detail !== 'done' ? event.detail : undefined }
              : step));
          }
        },
      }).then(
        answer => {
          const finalSteps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'done' as const } : s);
          setTurns(t => { const c = [...t]; c[c.length - 1] = { ...c[c.length - 1], text: c[c.length - 1].text + '\n\n' + answer, stats: capturedStats, progressSteps: finalSteps }; return c; });
          setBusy(false);
        },
        err => {
          const finalSteps = progressStepsRef.current.map(s => s.state === 'running' ? { ...s, state: 'failed' as const } : s);
          setTurns(t => { const c = [...t]; c[c.length - 1] = { ...c[c.length - 1], text: c[c.length - 1].text + `\n\nerror: ${(err as Error).message}`, progressSteps: finalSteps }; return c; });
          setBusy(false);
        },
      );
      return;
    }
    if (q === '/eval investing') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true); setStatus('running eval…'); setLiveTokens({ input: 0, output: 0 });
      session.evalInvesting().then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
      );
      return;
    }
    if (q === '/eval research') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setBusy(true); setStatus('running eval…'); setLiveTokens({ input: 0, output: 0 });
      session.evalResearch().then(
        answer => { setTurns(t => [...t, { role: 'buffr', text: answer }]); setBusy(false); },
        err    => { setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}` }]); setBusy(false); },
      );
      return;
    }
    if (q === '/eval') {
      setTurns(t => [...t, { role: 'you', text: q }]);
      setTurns(t => [...t, { role: 'buffr', text: 'Usage: /eval investing | /eval research' }]);
      return;
    }
    setTurns(t => [...t, { role: 'you', text: q }]);
    setBusy(true);
    setStatus('thinking…');
    setLiveTokens({ input: 0, output: 0 });
    let capturedStats: TurnStats | undefined;
    session.ask(q, {
      onStatus: (msg) => setStatus(msg),
      onTokens: (d) => setLiveTokens(t => ({ input: t.input + d.input, output: t.output + d.output })),
      onComplete: (s) => { capturedStats = s; },
    }).then(
      answer => {
        setTurns(t => [...t, { role: 'buffr', text: answer, stats: capturedStats }]);
        setBusy(false);
      },
      err => {
        setTurns(t => [...t, { role: 'buffr', text: `error: ${(err as Error).message}`, stats: capturedStats }]);
        setBusy(false);
      },
    );
  };

  useKeyboard((e: any) => {
    if (e.ctrl && e.name === 'c') {
      onExit().catch(() => process.exit(1));
      return;
    }
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
        <text fg="#888888">buffr chat — one conversation, held in-process. Type /help for commands, /exit to quit.</text>
      </box>

      {/* turns — scrollable, grows to fill remaining space */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <scrollbox ref={scrollRef} flexGrow={1} scrollY stickyScroll stickyStart="bottom" scrollbarOptions={{ color: '#333333' } as any}>
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
                {t.progressSteps && t.progressSteps.length > 0 && (
                  <StepList steps={t.progressSteps} />
                )}
                <text fg="#E8E8E8" marginLeft={2}>{t.text}</text>
                {t.stats && (
                  <text fg="#555555" marginLeft={2}>{formatStats(t.stats)}</text>
                )}
              </>
            )}
          </box>
        ))}
        {busy && <ProgressPanel status={status} tokens={liveTokens} steps={progressSteps} />}
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
          marginBottom={1}
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

const forceExit = () => { setTimeout(() => process.exit(0), 1500).unref(); session.close().finally(() => process.exit(0)); };

process.on('SIGINT', forceExit);

createRoot(renderer).render(
  <Chat
    session={session}
    onExit={async () => { forceExit(); }}
  />,
);
