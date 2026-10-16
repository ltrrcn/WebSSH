import { StringDecoder } from 'node:string_decoder';
import { redact, truncateDigest } from '../crypto/redact.js';

const MAX_COMMAND_LINE = 8192;
const MAX_OUTPUT_LINE = 16384;
const MAX_PROMPT = 1024;
const MAX_QUEUE = 256;
const MAX_DIGEST = 65536;

function outputLimit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(MAX_DIGEST, Math.floor(value))) : 2048;
}

function promptIdentity(text) {
  let match = text.match(/^([\w.-]+@[\w.-]+):(?:[~\/][^\r\n]*|)[$#]$/);
  if (match) return `host:${match[1]}`;
  match = text.match(/^([\w.-]+@[\w.-]+) (?:[~\/][^\r\n%]*|[\w.-]+) %$/);
  if (match) return `zsh:${match[1]}`;
  match = text.match(/^\[([\w.-]+@[\w.-]+) [^\]\r\n]+\][$#]$/);
  if (match) return `bracket:${match[1]}`;
  match = text.match(/^(bash|sh|zsh)(?:-\d+(?:\.\d+)*)?[$#%]$/);
  return match ? `shell:${match[1]}` : null;
}

function safeDigest(output, limit) {
  const clean = redact(output).replace(/-----BEGIN[\s\S]*$/, '[REDACTED PRIVATE KEY]');
  return truncateDigest(clean, limit).content.trimEnd();
}

// This parser observes a terminal; it never rewrites traffic or installs shell hooks.
function controlParser(onText, onOsc) {
  let state = 'text';
  let osc = '';
  return {
    write(text) {
      for (const ch of text) {
        if (state === 'text') {
          if (ch === '\x1b') state = 'esc';
          else if (ch === '\u009b') state = 'csi';
          else if (ch === '\u009d') { state = 'osc'; osc = ''; }
          else onText(ch);
        } else if (state === 'esc') {
          if (ch === '[') state = 'csi';
          else if (ch === ']') { state = 'osc'; osc = ''; }
          else if (ch === 'O') state = 'ss3';
          else if ('PX^_'.includes(ch)) state = 'string';
          else state = 'text';
        } else if (state === 'csi' || state === 'ss3') {
          if (ch >= '@' && ch <= '~') state = 'text';
          else if (ch === '\x1b') state = 'esc';
        } else if (state === 'osc') {
          if (ch === '\x07' || ch === '\u009c') { state = 'text'; onOsc?.(osc); osc = ''; }
          else if (ch === '\x1b') state = 'oscEsc';
          else if (osc.length < 128) osc += ch;
        } else if (state === 'oscEsc') {
          if (ch === '\\') { state = 'text'; onOsc?.(osc); osc = ''; }
          else state = 'osc';
        } else if (state === 'string') {
          if (ch === '\x1b') state = 'stringEsc';
          else if (ch === '\u009c') state = 'text';
        } else if (state === 'stringEsc') {
          state = ch === '\\' ? 'text' : 'string';
        }
      }
    },
    reset() { state = 'text'; osc = ''; },
  };
}

/**
 * Commands and expected echoes have separate FIFOs: an early echo is not an
 * execution boundary. Only a recognizable prompt / OSC 133 ends a command.
 * Unknown prompts, multiline editing and full-screen programs are conservative:
 * close still logs every command, but omits an untrustworthy output digest.
 */
export function createCommandRecorder(session, audit, getOutputCfg) {
  let inputDecoder = new StringDecoder('utf8');
  let outputDecoder = new StringDecoder('utf8');
  let inputLine = '';
  let inputOverflow = false;
  let outputLine = '';
  let outputOverflow = false;
  let carriageReturn = false;
  let afterPrompt = false;
  let closed = false;
  let hasPrompt = false;
  let identity = null;
  let prompt = '';
  let oscInPrompt = false;
  let oscCompleted = false;
  let suppressTextPrompt = false;
  let desynchronized = false;
  let outputEnabled = false;
  const queue = [];
  const echoes = [];
  const completed = [];

  const config = () => {
    const cfg = getOutputCfg() ?? {};
    return { enabled: cfg.enabled === true, digestBytes: outputLimit(cfg.digestBytes) };
  };

  function emit(entry, includeOutput, cfg = config()) {
    if (entry.logged) return;
    entry.logged = true;
    const event = {
      actor: session.ownerId,
      actorType: 'user',
      hostId: session.hostId,
      sessionId: session.id,
      event: 'command',
      result: 'success',
      command: entry.command,
    };
    if (includeOutput && cfg.enabled && entry.capture && entry.output.trim()) {
      const ambiguous = entry.suspects.some((suspect) => suspect.end > suspect.start && !suspect.resolved);
      if (!ambiguous) {
        let output = entry.output;
        for (const suspect of entry.suspects.slice().reverse()) {
          if (suspect.resolved === 'echo') output = output.slice(0, suspect.start) + output.slice(suspect.end);
        }
        const digest = safeDigest(output, cfg.digestBytes);
        if (digest.trim()) event.outputDigest = digest;
      }
    }
    entry.output = '';
    entry.suspects.length = 0;
    try {
      const result = audit.log(event);
      result?.catch?.(() => {});
    } catch {
      // An audit sink failure must not corrupt parser state or stop passthrough.
    }
  }

  function drain(includeOutput = false, cfg = config()) {
    while (completed.length) emit(completed.shift(), includeOutput, cfg);
    while (queue.length) emit(queue.shift(), includeOutput, cfg);
    echoes.length = 0;
  }

  function syncConfig() {
    const cfg = config();
    if (!cfg.enabled && (outputEnabled || queue.length)) {
      drain(false, cfg);
      outputLine = '';
      outputOverflow = false;
      carriageReturn = false;
      afterPrompt = false;
      oscInPrompt = false;
      oscCompleted = false;
      suppressTextPrompt = false;
      outputDecoder = new StringDecoder('utf8');
      outputParser.reset();
    }
    outputEnabled = cfg.enabled;
    return cfg;
  }

  function append(text) {
    const entry = queue[0];
    if (!entry || !text || oscInPrompt) return;
    if (!hasPrompt && !entry.started) return;
    entry.started = true;
    if (!entry.capture || desynchronized) return;
    const remaining = entry.cap - entry.output.length;
    if (remaining > 0) entry.output += text.slice(0, remaining);
  }

  function consumeLine(text, newline) {
    const active = queue[0];
    if (!outputOverflow) {
      if (active?.preEcho && text) {
        const prior = active.preEcho;
        active.preEcho = null;
        if (!active.outputStarted && text === prior.text) {
          prior.resolved = 'real';
          active.started = true;
          return;
        }
        prior.resolved = 'echo';
      }
      const echo = echoes[0];
      if (echo && text === echo.text) {
        echoes.shift();
        echo.entry.started = true;
        if (active && echo.entry !== active) {
          const start = active.output.length;
          append(text + (newline ? '\n' : ''));
          const suspect = { text, start, end: active.output.length, resolved: null };
          active.suspects.push(suspect);
          echo.entry.preEcho = suspect;
        }
        return;
      }
      if (inputLine && text === inputLine) return;
    }
    if (active && text) active.outputStarted = true;
    append(text + (newline ? '\n' : ''));
  }

  function finish() {
    const entry = queue[0];
    if (!entry || (!entry.started && !entry.ready)) return;
    queue.shift();
    if (entry.preEcho) { entry.preEcho.resolved = 'echo'; entry.preEcho = null; }
    const echoIndex = echoes.findIndex((echo) => echo.entry === entry);
    if (echoIndex !== -1) echoes.splice(echoIndex, 1);
    completed.push(entry);
  }

  function recognizePrompt() {
    if (outputOverflow && outputLine.length > MAX_PROMPT) return false;
    if (outputLine && (echoes.some((echo) => echo.text.startsWith(outputLine)) || inputLine.startsWith(outputLine))) return false;
    let candidate = outputLine;
    let prefix = '';
    let key = promptIdentity(candidate);
    if (!key || (identity && key !== identity)) {
      if (!prompt || !candidate.endsWith(prompt)) return false;
      prefix = candidate.slice(0, -prompt.length);
      candidate = prompt;
      key = identity;
    }
    if (!key || candidate.length > MAX_PROMPT) return false;
    if (prefix) consumeLine(prefix, false);
    if (!suppressTextPrompt) finish();
    hasPrompt = true;
    for (const entry of queue) entry.ready = true;
    identity = key;
    prompt = candidate;
    desynchronized = false;
    suppressTextPrompt = false;
    outputLine = '';
    outputOverflow = false;
    carriageReturn = false;
    afterPrompt = true;
    return true;
  }

  function outputChar(ch) {
    if (' \r\n'.includes(ch) && /[$#%]$/.test(outputLine) && recognizePrompt()) {
      if (ch === ' ') { afterPrompt = false; return; }
    }
    if (ch === '\r') { carriageReturn = true; return; }
    if (ch === '\n') {
      if (!oscInPrompt && !afterPrompt) consumeLine(outputLine, true);
      outputLine = '';
      outputOverflow = false;
      carriageReturn = false;
      afterPrompt = false;
      return;
    }
    if (carriageReturn) {
      outputLine = '';
      outputOverflow = false;
      carriageReturn = false;
    }
    if (ch === '\b' || ch === '\x7f') {
      outputLine = Array.from(outputLine).slice(0, -1).join('');
      return;
    }
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return;
    afterPrompt = false;
    outputLine += ch;
    if (outputLine.length > MAX_OUTPUT_LINE) {
      append(outputLine.slice(0, -MAX_PROMPT));
      outputLine = outputLine.slice(-MAX_PROMPT);
      outputOverflow = true;
    }
  }

  function outputOsc(sequence) {
    const match = sequence.match(/^133;([ABCD])(?:;.*)?$/);
    if (!match) return;
    const marker = match[1];
    if (marker === 'D' && oscCompleted) return;
    if (marker === 'A' || marker === 'D') {
      if (outputLine && !oscInPrompt) consumeLine(outputLine, false);
      outputLine = '';
      outputOverflow = false;
      carriageReturn = false;
      if (marker === 'D') {
        if (!oscCompleted) {
          if (queue[0]) queue[0].started = true;
          finish();
        }
        oscCompleted = true;
        oscInPrompt = false;
      } else {
        if (!oscCompleted && !oscInPrompt) finish();
        oscInPrompt = true;
      }
      hasPrompt = true;
      for (const entry of queue) entry.ready = true;
      desynchronized = false;
      suppressTextPrompt = true;
    } else if (marker === 'B') {
      outputLine = '';
      outputOverflow = false;
      oscInPrompt = false;
      afterPrompt = false;
    } else {
      if (outputLine && !oscInPrompt) consumeLine(outputLine, false);
      outputLine = '';
      outputOverflow = false;
      oscInPrompt = false;
      oscCompleted = false;
      suppressTextPrompt = false;
      hasPrompt = true;
      if (queue[0]) {
        queue[0].started = true;
        if (queue[0].preEcho) { queue[0].preEcho.resolved = 'echo'; queue[0].preEcho = null; }
        for (const suspect of queue[0].suspects) suspect.resolved = 'echo';
      }
    }
  }

  function submit() {
    const text = inputLine;
    const overflow = inputOverflow;
    inputLine = '';
    inputOverflow = false;
    if (!text.trim()) return;
    const cfg = syncConfig();
    const entry = {
      command: text.slice(0, 2000),
      output: '',
      cap: Math.min(MAX_DIGEST * 2, Math.max(1024, cfg.digestBytes * 2)),
      capture: !overflow && !desynchronized,
      ready: hasPrompt,
      started: false,
      outputStarted: false,
      suspects: [],
      preEcho: null,
      logged: false,
    };
    if (!cfg.enabled || desynchronized) { emit(entry, false, cfg); return; }
    if (queue.length >= MAX_QUEUE || echoes.length >= MAX_QUEUE) {
      drain(false, cfg);
      desynchronized = true;
      outputLine = '';
      outputOverflow = false;
      emit(entry, false, cfg);
      return;
    }
    queue.push(entry);
    if (!overflow) echoes.push({ text, entry });
  }

  function inputChar(ch) {
    if (ch === '\r' || ch === '\n') submit();
    else if (ch === '\x7f' || ch === '\b') inputLine = Array.from(inputLine).slice(0, -1).join('');
    else if (ch === '\x03' || ch === '\x15') { inputLine = ''; inputOverflow = false; }
    else if (ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) !== 0x7f) {
      if (inputLine.length < MAX_COMMAND_LINE) inputLine += ch;
      else inputOverflow = true;
    }
  }

  const inputParser = controlParser(inputChar);
  const outputParser = controlParser(outputChar, outputOsc);
  const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);

  return {
    feed(payload) {
      if (closed) return;
      syncConfig();
      inputParser.write(inputDecoder.write(bytes(payload)));
    },
    onOutput(chunk) {
      if (closed || !syncConfig().enabled) return;
      try {
        outputParser.write(outputDecoder.write(bytes(chunk)));
      } finally {
        while (completed.length) emit(completed.shift(), true);
      }
    },
    flush() {
      if (closed) return;
      const cfg = syncConfig();
      const trustworthy = cfg.enabled && hasPrompt && !desynchronized && queue.length === 1;
      if (trustworthy && outputLine && !oscInPrompt) consumeLine(outputLine, false);
      closed = true;
      drain(trustworthy, cfg);
      inputLine = '';
      outputLine = '';
      inputParser.reset();
      outputParser.reset();
      inputDecoder = null;
      outputDecoder = null;
    },
  };
}
