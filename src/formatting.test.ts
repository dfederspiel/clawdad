import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  getTriggerPattern,
  TRIGGER_PATTERN,
} from './config.js';
import {
  escapeXml,
  formatMessages,
  formatOutbound,
  renderQuotedContextText,
  renderQuotedContextXml,
  stripInternalTags,
  toStructuredMessages,
} from './router.js';
import { parseTextStyles, parseSignalStyles } from './text-styles.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('>hello</message>');
    expect(result).toContain('Jan 1, 2024');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T01:00:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages(
      [makeMsg({ content: '<script>alert("xss")</script>' })],
      TZ,
    );
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>\n\n</messages>');
  });

  it('converts timestamps to local time for given timezone', () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('<context timezone="America/New_York" />');
  });

  // #140 — quote-reply: a replying message should carry both a reply_to_id
  // attribute and an inline <quoted_context> block when quoted_context_xml
  // is attached. Round-trip through toStructuredMessages must surface the
  // text variant as a content preamble.
  it('renders reply_to_id and nested <quoted_context> when set', () => {
    const replying = makeMsg({
      id: 'r1',
      content: 'follow-up',
      reply_to_message_id: 'orig-1',
      quoted_context_xml:
        '      <message role="user" sender="Bob" time="9:00 AM">original</message>',
    });
    const result = formatMessages([replying], TZ);
    expect(result).toContain('reply_to_id="orig-1"');
    expect(result).toContain('<quoted_context>');
    expect(result).toContain('original</message>');
    expect(result).toContain('follow-up</message>');
  });

  it('omits the quoted_context block when no field is set', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).not.toContain('<quoted_context>');
    expect(result).not.toContain('reply_to_id=');
  });

  // #141 — message id is exposed as an attribute so agents can reference
  // prior messages (e.g. their own outputs) in update_block calls.
  it('emits the host-assigned id attribute on every message', () => {
    const result = formatMessages(
      [makeMsg({ id: 'msg-abc-123', content: 'hello' })],
      TZ,
    );
    expect(result).toContain('id="msg-abc-123"');
  });

  it('escapes the id attribute', () => {
    const result = formatMessages([makeMsg({ id: 'evil"id<x' })], TZ);
    expect(result).toContain('id="evil&quot;id&lt;x"');
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it('matches @name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

describe('getTriggerPattern', () => {
  it('uses the configured per-group trigger when provided', () => {
    const pattern = getTriggerPattern('@Claw');

    expect(pattern.test('@Claw hello')).toBe(true);
    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(false);
  });

  it('falls back to the default trigger when group trigger is missing', () => {
    const pattern = getTriggerPattern(undefined);

    expect(pattern.test(`@${ASSISTANT_NAME} hello`)).toBe(true);
  });

  it('treats regex characters in custom triggers literally', () => {
    const pattern = getTriggerPattern('@C.L.A.U.D.E');

    expect(pattern.test('@C.L.A.U.D.E hello')).toBe(true);
    expect(pattern.test('@CXLXAUXDXE hello')).toBe(false);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check group.trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    trigger: string | undefined,
    messages: NewMessage[],
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;
    const triggerPattern = getTriggerPattern(trigger);
    return messages.some((m) => triggerPattern.test(m.content.trim()));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, undefined, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, undefined, msgs)).toBe(true);
  });

  it('non-main group uses its per-group trigger instead of the default trigger', () => {
    const msgs = [makeMsg({ content: '@Claw do something' })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(true);
  });

  it('non-main group does not process when only the default trigger is present for a custom-trigger group', () => {
    const msgs = [makeMsg({ content: `@${ASSISTANT_NAME} do something` })];
    expect(shouldProcess(false, true, '@Claw', msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, undefined, msgs)).toBe(true);
  });
});

// --- parseTextStyles ---

describe('parseTextStyles — passthrough channels', () => {
  it('passes text through unchanged on discord', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'discord')).toBe(md);
  });

  it('passes text through unchanged on signal (signal uses parseSignalStyles)', () => {
    const md = '**bold** and *italic* and [link](https://example.com)';
    expect(parseTextStyles(md, 'signal')).toBe(md);
  });
});

describe('parseTextStyles — bold', () => {
  it('converts **bold** to *bold* on whatsapp', () => {
    expect(parseTextStyles('**hello**', 'whatsapp')).toBe('*hello*');
  });

  it('converts **bold** to *bold* on telegram', () => {
    expect(parseTextStyles('say **this** now', 'telegram')).toBe(
      'say *this* now',
    );
  });

  it('converts **bold** to *bold* on slack', () => {
    expect(parseTextStyles('**hello**', 'slack')).toBe('*hello*');
  });

  it('does not convert a lone * as bold', () => {
    expect(parseTextStyles('a * b * c', 'whatsapp')).toBe('a * b * c');
  });
});

describe('parseTextStyles — italic', () => {
  it('converts *italic* to _italic_ on whatsapp', () => {
    expect(parseTextStyles('say *this* now', 'whatsapp')).toBe(
      'say _this_ now',
    );
  });

  it('converts *italic* to _italic_ on telegram', () => {
    expect(parseTextStyles('*italic*', 'telegram')).toBe('_italic_');
  });

  it('bold-before-italic: **bold** *italic* → *bold* _italic_', () => {
    expect(parseTextStyles('**bold** *italic*', 'whatsapp')).toBe(
      '*bold* _italic_',
    );
  });
});

describe('parseTextStyles — headings', () => {
  it('converts # heading on whatsapp', () => {
    expect(parseTextStyles('# Top', 'whatsapp')).toBe('*Top*');
  });

  it('converts ## heading on telegram', () => {
    expect(parseTextStyles('## Hello World', 'telegram')).toBe('*Hello World*');
  });

  it('converts ### heading on telegram', () => {
    expect(parseTextStyles('### Section', 'telegram')).toBe('*Section*');
  });

  it('only converts headings at line start', () => {
    const input = 'not a ## heading in middle';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });
});

describe('parseTextStyles — links', () => {
  it('converts [text](url) to text (url) on whatsapp', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'whatsapp')).toBe(
      'Link (https://example.com)',
    );
  });

  it('converts [text](url) to text (url) on telegram', () => {
    expect(parseTextStyles('[Link](https://example.com)', 'telegram')).toBe(
      'Link (https://example.com)',
    );
  });

  it('converts [text](url) to <url|text> on slack', () => {
    expect(parseTextStyles('[Click here](https://example.com)', 'slack')).toBe(
      '<https://example.com|Click here>',
    );
  });
});

describe('parseTextStyles — horizontal rules', () => {
  it('strips --- on telegram', () => {
    expect(parseTextStyles('above\n---\nbelow', 'telegram')).toBe(
      'above\n\nbelow',
    );
  });

  it('strips *** on whatsapp', () => {
    expect(parseTextStyles('above\n***\nbelow', 'whatsapp')).toBe(
      'above\n\nbelow',
    );
  });
});

describe('parseTextStyles — code block protection', () => {
  it('does not transform **bold** inside fenced code block', () => {
    const input = '```\n**not bold**\n```';
    expect(parseTextStyles(input, 'whatsapp')).toBe(input);
  });

  it('does not transform *italic* inside inline code', () => {
    const input = 'use `*star*` literally';
    expect(parseTextStyles(input, 'telegram')).toBe(input);
  });

  it('transforms text outside code blocks but not inside', () => {
    const input = '**bold** and `*code*` and *italic*';
    expect(parseTextStyles(input, 'whatsapp')).toBe(
      '*bold* and `*code*` and _italic_',
    );
  });

  it('transforms text outside fenced block but not inside', () => {
    const input = '**bold**\n```\n**raw**\n```\n*italic*';
    expect(parseTextStyles(input, 'telegram')).toBe(
      '*bold*\n```\n**raw**\n```\n_italic_',
    );
  });
});

// --- parseSignalStyles ---

describe('parseSignalStyles — basic styles', () => {
  it('extracts BOLD from **text**', () => {
    const { text, textStyle } = parseSignalStyles('**hello**');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from *text*', () => {
    const { text, textStyle } = parseSignalStyles('*hello*');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts ITALIC from _text_', () => {
    const { text, textStyle } = parseSignalStyles('_hello_');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([{ style: 'ITALIC', start: 0, length: 5 }]);
  });

  it('extracts STRIKETHROUGH from ~~text~~', () => {
    const { text, textStyle } = parseSignalStyles('~~hello~~');
    expect(text).toBe('hello');
    expect(textStyle).toEqual([
      { style: 'STRIKETHROUGH', start: 0, length: 5 },
    ]);
  });

  it('extracts MONOSPACE from `inline code`', () => {
    const { text, textStyle } = parseSignalStyles('`code`');
    expect(text).toBe('code');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 4 }]);
  });

  it('extracts BOLD from ## heading and strips marker', () => {
    const { text, textStyle } = parseSignalStyles('## Hello World');
    expect(text).toBe('Hello World');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 0, length: 11 }]);
  });

  it('no styles for plain text', () => {
    const { text, textStyle } = parseSignalStyles('just plain text');
    expect(text).toBe('just plain text');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — mixed content', () => {
  it('correctly offsets styles in mixed text', () => {
    const { text, textStyle } = parseSignalStyles('say **hi** now');
    expect(text).toBe('say hi now');
    expect(textStyle).toEqual([{ style: 'BOLD', start: 4, length: 2 }]);
  });

  it('handles multiple styles with correct offsets', () => {
    const { text, textStyle } = parseSignalStyles('**bold** and *italic*');
    expect(text).toBe('bold and italic');
    expect(textStyle[0]).toEqual({ style: 'BOLD', start: 0, length: 4 });
    expect(textStyle[1]).toEqual({ style: 'ITALIC', start: 9, length: 6 });
  });

  it('strips link markers, no style applied', () => {
    const { text, textStyle } = parseSignalStyles(
      '[Click here](https://example.com)',
    );
    expect(text).toBe('Click here (https://example.com)');
    expect(textStyle).toHaveLength(0);
  });

  it('strips horizontal rules', () => {
    const { text, textStyle } = parseSignalStyles('above\n---\nbelow');
    expect(text).toBe('above\nbelow');
    expect(textStyle).toHaveLength(0);
  });
});

describe('parseSignalStyles — code block protection', () => {
  it('protects fenced code block content with MONOSPACE', () => {
    const input = '```\n**not bold**\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toBe('**not bold**');
    expect(textStyle).toEqual([{ style: 'MONOSPACE', start: 0, length: 12 }]);
  });

  it('styles outside block are still processed', () => {
    const input = '**bold**\n```\nraw code\n```';
    const { text, textStyle } = parseSignalStyles(input);
    expect(text).toContain('bold');
    expect(text).toContain('raw code');
    const boldStyle = textStyle.find((s) => s.style === 'BOLD');
    const codeStyle = textStyle.find((s) => s.style === 'MONOSPACE');
    expect(boldStyle).toBeDefined();
    expect(codeStyle).toBeDefined();
  });
});

describe('parseSignalStyles — snake_case guard', () => {
  it('does not italicise underscores in snake_case', () => {
    const { text, textStyle } = parseSignalStyles('use snake_case_here');
    expect(text).toBe('use snake_case_here');
    expect(textStyle).toHaveLength(0);
  });
});

describe('formatOutbound — channel-aware', () => {
  it('applies parseTextStyles when channel is provided', () => {
    expect(formatOutbound('**bold**', 'whatsapp')).toBe('*bold*');
  });

  it('returns plain stripped text when no channel provided', () => {
    expect(formatOutbound('**bold**')).toBe('**bold**');
  });

  it('strips internal tags then applies channel formatting', () => {
    expect(
      formatOutbound('<internal>thinking</internal>**done**', 'telegram'),
    ).toBe('*done*');
  });

  it('signal channel is passthrough — raw markdown preserved for parseSignalStyles', () => {
    expect(formatOutbound('**bold**', 'signal')).toBe('**bold**');
  });
});

// --- toStructuredMessages (#46) ---

describe('toStructuredMessages', () => {
  it('returns an empty array for no messages', () => {
    expect(toStructuredMessages([])).toEqual([]);
  });

  it('maps is_bot_message: true to role="assistant"', () => {
    const out = toStructuredMessages([
      makeMsg({ is_bot_message: true, sender_name: 'Andy', content: 'hi' }),
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'hi',
        sender: 'Andy',
        timestamp: '2024-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('maps is_bot_message: false (and missing) to role="user"', () => {
    const out = toStructuredMessages([
      makeMsg({
        sender_name: 'Alice',
        content: 'hello',
        is_bot_message: false,
      }),
      makeMsg({ sender_name: 'Bob', content: 'hey' }), // is_bot_message omitted
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'user']);
  });

  it('preserves role authority via is_bot_message regardless of sender_name', () => {
    // A human user named "Assistant" should still be role: user —
    // this proves we no longer rely on the fragile name-match heuristic
    // that the old parseXmlMessages used.
    const out = toStructuredMessages([
      makeMsg({
        sender_name: 'Assistant',
        content: 'typed by a real user',
        is_bot_message: false,
      }),
    ]);
    expect(out[0].role).toBe('user');
  });

  it('carries content, sender, and timestamp through unchanged', () => {
    const out = toStructuredMessages([
      makeMsg({
        sender_name: 'Alice',
        content: 'Look at <this> & "that"',
        timestamp: '2026-04-19T03:00:00.000Z',
      }),
    ]);
    expect(out[0]).toEqual({
      role: 'user',
      content: 'Look at <this> & "that"',
      sender: 'Alice',
      timestamp: '2026-04-19T03:00:00.000Z',
    });
  });

  it('preserves order', () => {
    const out = toStructuredMessages([
      makeMsg({ id: '1', sender_name: 'A', content: 'first' }),
      makeMsg({
        id: '2',
        sender_name: 'Andy',
        content: 'second',
        is_bot_message: true,
      }),
      makeMsg({ id: '3', sender_name: 'A', content: 'third' }),
    ]);
    expect(out.map((m) => m.content)).toEqual(['first', 'second', 'third']);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  // #140 — quote-reply text variant must be prepended to content so non-XML
  // runtimes (Ollama) see the quoted preamble.
  it('prepends quoted_context_text to content when present', () => {
    const out = toStructuredMessages([
      makeMsg({
        id: 'reply-1',
        content: 'thanks for clarifying',
        quoted_context_text:
          '[Replying to an earlier message — surrounding context:]\n> [9:00 AM] Bob: original\n[End of quoted context]',
      }),
    ]);
    expect(out[0].content).toContain('Replying to an earlier message');
    expect(out[0].content).toContain('Bob: original');
    expect(out[0].content.endsWith('thanks for clarifying')).toBe(true);
  });
});

// --- renderQuotedContextXml / Text (#140) ---

describe('renderQuotedContextXml', () => {
  const TZ = 'UTC';
  const window = [
    makeMsg({
      id: 'a',
      sender_name: 'Alice',
      content: 'pre',
      timestamp: '2024-01-01T08:59:00.000Z',
    }),
    makeMsg({
      id: 'b',
      sender_name: 'Bob',
      content: 'anchor body',
      timestamp: '2024-01-01T09:00:00.000Z',
    }),
    makeMsg({
      id: 'c',
      sender_name: 'Carol',
      content: 'post',
      timestamp: '2024-01-01T09:01:00.000Z',
    }),
  ];

  it('marks the anchor with anchor="true"', () => {
    const out = renderQuotedContextXml(window, 'b', TZ, 4000);
    expect(out).toContain('sender="Bob"');
    expect(out).toContain('anchor="true"');
    // anchor attribute should only be on the anchor row
    expect(out.match(/anchor="true"/g)?.length).toBe(1);
  });

  it('includes surrounding messages without anchor attribute', () => {
    const out = renderQuotedContextXml(window, 'b', TZ, 4000);
    expect(out).toContain('>pre</message>');
    expect(out).toContain('>post</message>');
  });

  it('shrinks the window symmetrically when budget is tight', () => {
    // Make the surrounding messages big so dropping one drops below budget.
    const big = 'x'.repeat(500);
    const wide = [
      makeMsg({
        id: 'a',
        sender_name: 'Alice',
        content: big,
        timestamp: '2024-01-01T08:59:00.000Z',
      }),
      makeMsg({
        id: 'b',
        sender_name: 'Bob',
        content: 'anchor',
        timestamp: '2024-01-01T09:00:00.000Z',
      }),
      makeMsg({
        id: 'c',
        sender_name: 'Carol',
        content: big,
        timestamp: '2024-01-01T09:01:00.000Z',
      }),
    ];
    const out = renderQuotedContextXml(wide, 'b', TZ, 700);
    expect(out.length).toBeLessThanOrEqual(700);
    expect(out).toContain('>anchor</message>');
  });
});

describe('renderQuotedContextText', () => {
  const TZ = 'UTC';

  it('marks the anchor row with > and surrounds with brackets', () => {
    const window = [
      makeMsg({
        id: 'a',
        sender_name: 'Alice',
        content: 'pre',
        timestamp: '2024-01-01T08:59:00.000Z',
      }),
      makeMsg({
        id: 'b',
        sender_name: 'Bob',
        content: 'anchor body',
        timestamp: '2024-01-01T09:00:00.000Z',
      }),
    ];
    const out = renderQuotedContextText(window, 'b', TZ, 4000);
    expect(out).toContain('[Replying to an earlier message');
    expect(out).toContain('> ');
    expect(out).toContain('Bob: anchor body');
    expect(out).toContain('[End of quoted context]');
  });
});
